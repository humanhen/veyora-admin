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
