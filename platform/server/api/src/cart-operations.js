/* ADD ONE UNIT OF A SKU TO MY CART.
 *
 * Why this exists as its own operation rather than another call to
 * POST /user/add-to-cart:
 *
 *   /user/add-to-cart means SET THIS LINE TO THIS ABSOLUTE QUANTITY. The real
 *   cart's +/- controls, "Scan your list" and Quick reorder all depend on that
 *   meaning, and the checkout snapshot comparison is written against it. It
 *   must not quietly become "increment", and a client that wants "+1" cannot be
 *   built out of it either: posting {qty: 1} repeatedly pins the line at one.
 *
 *   Read-then-set from the browser is the other tempting shortcut and it is the
 *   classic lost update — two clicks (or two tabs, or two devices on the same
 *   account) both read 2 and both write 3.
 *
 * So the increment is expressed as ONE statement that the database applies
 * atomically. `set qty = cart_items.qty + 1` reads the conflicting row AFTER
 * taking its lock, so concurrent increments serialise and none is lost; and the
 * stock cap that applies when backorders are switched off is a predicate in
 * that same statement, re-evaluated against the locked row, so a second request
 * cannot slip past a limit the first one just consumed.
 *
 * Deliberately imports no database module — the query function is passed in —
 * so the rule can be tested on its own, the way ordering.js is.
 */

function deny(status, error, data) {
  return Object.assign(new Error(error), { status, expose: true, data: data || null });
}

/**
 * The established refusal wording for "backorders are off and the shelf cannot
 * cover this". Written once so the absolute-set endpoint and the increment
 * cannot drift into telling the customer two different things.
 */
export function stockRefusalMessage(sku, available) {
  return available > 0
    ? `Only ${available} left in stock for ${sku}.`
    : `${sku} is out of stock.`;
}

/* ---------------------------------------------------------------------------
   The atomic increment
   ---------------------------------------------------------------------------

   $1 user id · $2 variation sku · $3 are backorders allowed

   Three separate guarantees live in this one statement:

   1. SKU VALIDATION. The row being inserted comes from `variations`, so an
      unknown or de-activated sku produces no row and therefore no cart line —
      it is not a check the caller can forget to make first.

   2. NO LOST UPDATE. On conflict the existing row is LOCKED and then read, so
      `cart_items.qty + 1` is computed from the newest committed value. Five
      overlapping clicks produce five units.

   3. THE STOCK CAP, WHEN BACKORDERS ARE OFF. `cart_items.qty + 1 <= available`
      is evaluated on the locked row, after any concurrent increment has
      committed. Two requests racing for one remaining unit therefore cannot
      both succeed: the loser's predicate is false and it writes nothing.
      With backorders ON the predicate is simply skipped — deliberately
      ordering more than is on the shelf is the whole point of a backorder.

   A refused write is silent by design (zero rows, no error), so the caller
   decides what to tell the customer. See incrementCartLine(). */
export const CART_INCREMENT_SQL = `
  insert into cart_items (user_id, sku, qty)
  select $1, v.sku, 1
    from variations v
   where v.sku = $2
     and v.is_active
     and ($3::boolean
          or coalesce((select sum(s.qty) from stock s where s.variation_id = v.id), 0) >= 1)
  on conflict (user_id, sku) do update
     set qty = cart_items.qty + 1
   where $3::boolean
      or cart_items.qty + 1 <= coalesce((
           select sum(s.qty) from stock s
             join variations v2 on v2.id = s.variation_id
            where v2.sku = cart_items.sku), 0)
  returning cart_items.qty`;

/* Why the increment wrote nothing: the variation is gone/inactive, or the cap
   refused it. Only ever read on that path — the successful case costs one
   statement, not two. */
export const CART_INCREMENT_REFUSAL_SQL = `
  select coalesce((select sum(s.qty) from stock s where s.variation_id = v.id), 0) as available,
         coalesce((select ci.qty from cart_items ci
                    where ci.user_id = $1 and ci.sku = v.sku), 0) as qty
    from variations v
   where v.sku = $2 and v.is_active`;

const int = (v) => Math.trunc(Number(v) || 0);

/**
 * Add exactly one unit of `sku` to `userId`'s cart.
 *
 * @param runQuery parameterised query function, normally db.q
 * @param userId   the CART OWNER — the signed-in actor, even on an assisted
 *                 order, where only the pricing belongs to the customer
 * @param rawSku   the variation sku from the request
 * @param opts.allowBackorders the server's ALLOW_CUSTOMER_BACKORDERS policy
 * @returns { sku, qty } — the line's authoritative quantity after the increment
 * @throws  a tagged error ({status, expose, data}) the route renders as JSON
 */
export async function incrementCartLine(runQuery, userId, rawSku, { allowBackorders } = {}) {
  const sku = String(rawSku ?? '').trim();
  if (!sku) throw deny(400, 'sku required');

  const { rows } = await runQuery(CART_INCREMENT_SQL, [userId, sku, !!allowBackorders]);
  if (rows.length) return { sku, qty: int(rows[0].qty) };

  /* Nothing was written. Say WHICH of the two reasons it was, rather than a
     generic failure — "out of stock" and "that colour no longer exists" call
     for completely different things from the customer. */
  const { rows: probe } = await runQuery(CART_INCREMENT_REFUSAL_SQL, [userId, sku]);
  if (!probe.length) throw deny(404, 'unknown sku');

  const available = Math.max(0, int(probe[0].available));
  const requested = int(probe[0].qty) + 1;
  throw deny(409, stockRefusalMessage(sku, available), { sku, available, requested });
}
