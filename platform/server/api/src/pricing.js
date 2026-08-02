/* Customer-specific pricing + promotion evaluation.
   Mirrors the admin panel's DB.priceForCustomer so both sides agree. */

export function priceForCustomer(user, product, variation) {
  let price = variation?.sale_price ?? variation?.price
    ?? product.sale_price ?? product.price ?? 0;
  const pr = user?.pricing;
  if (!pr || pr.mode === 'none') return round2(price);
  if (pr.mode === 'sku' && pr.skuPrices && variation && pr.skuPrices[variation.sku] != null) {
    return round2(pr.skuPrices[variation.sku]);
  }
  if (pr.mode === 'brand' && pr.brands && pr.brands[product.brand] != null) {
    return round2(price * (1 - pr.brands[product.brand] / 100));
  }
  if (pr.mode === 'cart' && pr.cartPct) {
    return round2(price * (1 - pr.cartPct / 100));
  }
  if (pr.mode === 'tier' && pr.tiers && product.price != null
      && pr.tiers[String(product.price)] != null) {
    return round2(pr.tiers[String(product.price)]);
  }
  return round2(price);
}

export function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/**
 * Split one checkout's commercial terms between the order that ships now and
 * the backorder that holds the rest.
 *
 * The customer authorised ONE set of terms. Whether stock happened to be
 * available must not change what they end up paying, so:
 *   - the discount is applied to the immediate order first, and whatever it
 *     cannot absorb carries to the backorder (a fully backordered checkout
 *     previously lost its discount entirely — it was hardcoded to 0);
 *   - shipping is charged exactly ONCE: on the immediate order when there is
 *     one, otherwise on the backorder;
 *   - the promotion snapshot and the free-shipping decision travel with both.
 *
 * @param allocatedSubtotal  value of the lines that were in stock
 * @param backorderedSubtotal value of the lines that were not
 * @param promoDiscount      the whole discount the checkout earned
 * @param shippingCost       the shipping charge for the checkout
 * @param shippingFree       whether shipping was waived
 */
export function allocateCommercials({
  allocatedSubtotal = 0, backorderedSubtotal = 0,
  promoDiscount = 0, shippingCost = 0, shippingFree = false,
} = {}) {
  const alloc = round2(Math.max(0, allocatedSubtotal));
  const back = round2(Math.max(0, backorderedSubtotal));
  // A discount can never exceed what was actually bought.
  const discount = round2(Math.min(Math.max(0, promoDiscount), round2(alloc + back)));
  const hasOrder = alloc > 0;

  const orderDiscount = hasOrder ? round2(Math.min(discount, alloc)) : 0;
  const backorderDiscount = round2(discount - orderDiscount);
  const ship = round2(Math.max(0, shippingCost));

  return {
    order: {
      discount: orderDiscount,
      shipping: hasOrder ? ship : 0,
      freeShipping: Boolean(shippingFree),
      total: hasOrder ? round2(alloc - orderDiscount + ship) : 0,
    },
    backorder: {
      discount: backorderDiscount,
      // Charged here only when nothing shipped now, so it is never charged twice.
      shipping: hasOrder ? 0 : ship,
      freeShipping: Boolean(shippingFree),
      total: round2(back - backorderDiscount + (hasOrder ? 0 : ship)),
    },
    // What the customer authorised overall; the two totals must reconcile to it.
    authorisedTotal: round2(alloc + back - discount + ship),
  };
}

/** Which active promotions apply to this user today? */
export function eligiblePromotions(promos, user, isAgentOrder) {
  const today = new Date().toISOString().slice(0, 10);
  return promos.filter(p => {
    if (!p.active) return false;
    if (p.starts_on && p.starts_on > today) return false;
    if (p.ends_on && p.ends_on < today) return false;
    if (p.countries?.length && !p.countries.includes(user.country)) return false;
    if (isAgentOrder ? !p.ctx_agent : !p.ctx_customer) return false;
    if (p.audience === 'specific' && !p.customer_ids?.includes(user.id)) return false;
    if (p.audience === 'agents' && !p.agent_ids?.includes(user.agent_id)) return false;
    if (p.max_total > 0 && p.used_count >= p.max_total) return false;
    return true;
  });
}

/** Evaluate the best promotion against cart lines [{sku,qty,price}]. */
export function previewPromotions(promos, user, lines, isAgentOrder) {
  const totalQty = lines.reduce((s, l) => s + l.qty, 0);
  const subtotal = round2(lines.reduce((s, l) => s + l.qty * l.price, 0));
  let best = null;
  for (const p of eligiblePromotions(promos, user, isAgentOrder)) {
    if (p.min_qty > 0 && totalQty < p.min_qty) continue;
    let discount = 0, freeShipping = false, freeUnits = 0;
    if (p.reward_type === 'percent' && p.percent) discount = round2(subtotal * p.percent / 100);
    else if (p.reward_type === 'fixed' && p.fixed) discount = Math.min(round2(p.fixed), subtotal);
    else if (p.reward_type === 'free_shipping') freeShipping = true;
    else if (p.reward_type === 'tiered' && Array.isArray(p.tiers)) {
      // e.g. [{buy:20, free:2}] — value of cheapest N units credited
      const tier = [...p.tiers].sort((a, b) => b.buy - a.buy).find(t => totalQty >= t.buy);
      if (tier) {
        freeUnits = tier.free;
        const unitPrices = lines.flatMap(l => Array(l.qty).fill(l.price)).sort((a, b) => a - b);
        discount = round2(unitPrices.slice(0, tier.free).reduce((s, x) => s + x, 0));
      }
    }
    const value = discount + (freeShipping ? 0.01 : 0);
    if (value > 0 && (!best || value > best.value)) {
      best = { value, promo: { id: p.id, name: p.name, rewardType: p.reward_type },
               discount, freeShipping, freeUnits };
    }
  }
  return { subtotal, totalQty, applied: best ? { ...best.promo, discount: best.discount, freeShipping: best.freeShipping, freeUnits: best.freeUnits } : null };
}
