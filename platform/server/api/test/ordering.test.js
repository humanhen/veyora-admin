/* Who may order for whom, and how the free-text order note is bounded.

   resolveOrderingCustomer takes its query function as an argument, so the
   authorisation rule is exercised here without a database. It is the SAME
   function the cart preview and place-order both call, so what passes here is
   what the server actually enforces. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveOrderingCustomer, canActOnBehalf, sanitizeOrderNote,
  orderingContextShape, ORDER_NOTE_MAX, CUSTOMER_BACKORDER,
} from '../src/ordering.js';

const CUSTOMERS = {
  u_dana:  { id: 'u_dana',  role: 'customer', business: 'Dana Optical',
             customer_number: '1042', agent_id: 'u_sam', status: 'active' },
  u_rey:   { id: 'u_rey',   role: 'customer', business: 'Rey Eyewear',
             customer_number: '1043', agent_id: 'u_other', status: 'active' },
  u_stale: { id: 'u_stale', role: 'customer', business: 'Dormant Optics',
             customer_number: '1044', agent_id: 'u_sam', status: 'pending' },
};

/* A stand-in for db.q that understands the two shapes ordering.js issues:
   unscoped (admin/super-agent) and agent-scoped. */
function fakeQuery(calls = []) {
  return async (sql, params) => {
    calls.push({ sql, params });
    const [id] = params;
    const row = CUSTOMERS[id];
    if (!row) return { rows: [] };
    const orderable = params[params.length - 1];
    if (!orderable.includes(row.role)) return { rows: [] };
    if (sql.includes('agent_id=$2') && row.agent_id !== params[1]) return { rows: [] };
    return { rows: [row] };
  };
}

const agent = { id: 'u_sam', role: 'agent' };
const superAgent = { id: 'u_sup', role: 'super-agent' };
const admin = { id: 'u_adm', role: 'admin' };
const plainCustomer = { id: 'u_dana', role: 'customer' };

/* ---------------- who may act on behalf ---------------- */

test('only agent, super-agent and admin may act on behalf', () => {
  assert.equal(canActOnBehalf('agent'), true);
  assert.equal(canActOnBehalf('super-agent'), true);
  assert.equal(canActOnBehalf('admin'), true);
  assert.equal(canActOnBehalf('customer'), false);
  assert.equal(canActOnBehalf('special customer'), false);
  assert.equal(canActOnBehalf('warehouse'), false);
  assert.equal(canActOnBehalf(undefined), false);
});

/* ---------------- authorised selection ---------------- */

test('an agent may order for a customer on their own book', async () => {
  const { customer, onBehalf } = await resolveOrderingCustomer(agent, 'u_dana', fakeQuery());
  assert.equal(onBehalf, true);
  assert.equal(customer.id, 'u_dana');
  assert.equal(customer.business, 'Dana Optical');
});

test('an admin and a super-agent reach any customer', async () => {
  for (const staff of [admin, superAgent]) {
    const { customer, onBehalf } = await resolveOrderingCustomer(staff, 'u_rey', fakeQuery());
    assert.equal(onBehalf, true, `${staff.role} should reach any customer`);
    assert.equal(customer.id, 'u_rey');
  }
});

test('the agent-scoped lookup is genuinely scoped in SQL, not just in JS', async () => {
  const calls = [];
  await resolveOrderingCustomer(agent, 'u_dana', fakeQuery(calls));
  assert.match(calls[0].sql, /agent_id=\$2/, 'agents are constrained by the query itself');
  assert.equal(calls[0].params[1], 'u_sam');

  const adminCalls = [];
  await resolveOrderingCustomer(admin, 'u_rey', fakeQuery(adminCalls));
  assert.ok(!/agent_id/.test(adminCalls[0].sql), 'admins are not agent-scoped');
});

/* ---------------- unauthorised selection ---------------- */

test('an agent may NOT order for a customer outside their book', async () => {
  await assert.rejects(
    () => resolveOrderingCustomer(agent, 'u_rey', fakeQuery()),
    e => {
      assert.equal(e.status, 403);
      assert.equal(e.expose, true);
      assert.match(e.message, /Not your customer/);
      return true;
    });
});

test('an ORDINARY CUSTOMER submitting a customerId is refused', async () => {
  const calls = [];
  await assert.rejects(
    () => resolveOrderingCustomer(plainCustomer, 'u_rey', fakeQuery(calls)),
    e => {
      assert.equal(e.status, 403);
      assert.match(e.message, /cannot place an order for another account/);
      return true;
    });
  assert.equal(calls.length, 0, 'refused before any lookup — role alone decides');
});

test('a warehouse login cannot order for anyone either', async () => {
  await assert.rejects(
    () => resolveOrderingCustomer({ id: 'u_wh', role: 'warehouse' }, 'u_dana', fakeQuery()),
    e => e.status === 403);
});

test('an unknown customer id is refused, not silently ignored', async () => {
  await assert.rejects(
    () => resolveOrderingCustomer(admin, 'u_does_not_exist', fakeQuery()),
    e => e.status === 403);
});

test('an inactive customer account is refused with a distinct message', async () => {
  await assert.rejects(
    () => resolveOrderingCustomer(agent, 'u_stale', fakeQuery()),
    e => {
      assert.equal(e.status, 400);
      assert.match(e.message, /not active/);
      return true;
    });
});

test('a staff member may not order "for" another staff member', async () => {
  // u_sam is not in CUSTOMERS, so the ORDERABLE_ROLES filter yields nothing.
  await assert.rejects(
    () => resolveOrderingCustomer(admin, 'u_sam', fakeQuery()),
    e => e.status === 403);
});

/* ---------------- no context ---------------- */

test('no customerId means the actor orders for themselves', async () => {
  const calls = [];
  for (const id of [undefined, null, '', '   ']) {
    const { customer, onBehalf } = await resolveOrderingCustomer(agent, id, fakeQuery(calls));
    assert.equal(onBehalf, false);
    assert.equal(customer, agent, 'the actor is used as-is');
  }
  assert.equal(calls.length, 0, 'no lookup when there is nothing to resolve');
});

test('passing your own id is not "on behalf"', async () => {
  const { onBehalf } = await resolveOrderingCustomer(agent, 'u_sam', fakeQuery());
  assert.equal(onBehalf, false);
});

/* ---------------- what the storefront is told ---------------- */

test('the ordering context exposes only what the banner needs', () => {
  const shape = orderingContextShape(CUSTOMERS.u_dana);
  assert.deepEqual(Object.keys(shape).sort(), ['business', 'customerNumber', 'id']);
  assert.ok(!('email' in shape) && !('agent_id' in shape) && !('status' in shape),
    'no PII or internal fields leak into the banner payload');
});

/* ---------------- customer-created backorder state ---------------- */

test('the customer\'s authorisation is recorded, with no second approval step', () => {
  assert.equal(CUSTOMER_BACKORDER.customerAuthorised, true,
    'the customer authorised it by ordering an unavailable quantity');
});

test('customer authorisation does NOT assert stock eligibility', () => {
  // Batch 1A set eligible=true on the customer's say-so, which claimed stock was
  // available the instant the backorder was created — nobody had checked.
  // The two facts are now separate columns, and conversion is gated on real,
  // locked stock by the server.
  assert.equal(CUSTOMER_BACKORDER.eligible, false,
    'eligible is the staff/stock gate, not the customer authorisation');
  assert.notEqual(CUSTOMER_BACKORDER.eligible, CUSTOMER_BACKORDER.customerAuthorised,
    'the two concepts must not be conflated');
});

test('the state stays one the existing admin queue can actually process', () => {
  // js/pages_sales.js renders "Mark eligible" / "Convert" for an OPEN record and
  // its filter historically listed open/converted/cancelled. 'approved' would be
  // invisible to the filter AND actionless — a stranded row.
  assert.equal(CUSTOMER_BACKORDER.status, 'open');
  assert.notEqual(CUSTOMER_BACKORDER.status, 'approved',
    "'approved' strands the record in the admin backorder queue");
});

test('customer-created backorders are distinguishable from warehouse-raised ones', () => {
  assert.equal(CUSTOMER_BACKORDER.reason, 'customer backorder');
  assert.notEqual(CUSTOMER_BACKORDER.reason, 'out_of_stock',
    'the collection screen uses out_of_stock; staff must be able to tell them apart');
});

test('the backorder state constants cannot be mutated by a caller', () => {
  assert.throws(() => { CUSTOMER_BACKORDER.status = 'approved'; }, TypeError);
});

/* ---------------- order note ---------------- */

test('the order note is trimmed', () => {
  assert.equal(sanitizeOrderNote('   pack separately   '), 'pack separately');
});

test('the order note is length-limited', () => {
  const long = 'x'.repeat(ORDER_NOTE_MAX + 5000);
  assert.equal(sanitizeOrderNote(long).length, ORDER_NOTE_MAX);
});

test('the order note survives missing / non-string input', () => {
  for (const v of [undefined, null, 0, false]) {
    assert.equal(typeof sanitizeOrderNote(v), 'string');
  }
  assert.equal(sanitizeOrderNote(undefined), '');
  assert.equal(sanitizeOrderNote(null), '');
});

test('the order note keeps newlines and tabs but drops control characters', () => {
  const withNewline = sanitizeOrderNote('line one\nline two\tindented');
  assert.equal(withNewline, 'line one\nline two\tindented');
  const withControls = sanitizeOrderNote(`a${String.fromCharCode(0)}b${String.fromCharCode(7)}c${String.fromCharCode(127)}`);
  assert.equal(withControls, 'abc', 'NUL, BEL and DEL are removed');
});

test('the order note is stored verbatim — escaping is the renderer\'s job', () => {
  // Deliberately NOT stripped here: it is written to a text field and every
  // surface escapes it. Stripping would only give a false sense of safety.
  const raw = '<script>alert(1)</script> & "quotes"';
  assert.equal(sanitizeOrderNote(raw), raw);
});
