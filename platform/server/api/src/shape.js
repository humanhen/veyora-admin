/* Mapping between admin-panel JSON row shapes (camelCase, nested) and DB rows.
   The admin panel keeps its whole dataset in memory and syncs row-level diffs;
   these maps define, per collection, how a JSON row becomes table columns.

   `fields` maps jsKey -> column. Values pass through as-is except:
   json = stored in a jsonb column, arr = text[] column. */

export const SIMPLE_COLLECTIONS = {
  warehouses: {
    table: 'warehouses',
    fields: { id: 'id', code: 'code', name: 'name' },
  },
  users: {
    table: 'users',
    // password_hash intentionally absent — never read from or written by sync.
    fields: {
      id: 'id', customerNumber: 'customer_number', username: 'username',
      firstName: 'first_name', lastName: 'last_name', email: 'email',
      phone: 'phone', business: 'business', taxId: 'tax_id', country: 'country',
      address: 'address', city: 'city', state: 'state', zip: 'zip',
      role: 'role', agentId: 'agent_id', paymentTerms: 'payment_terms',
      hidePrices: 'hide_prices', status: 'status', pricing: { col: 'pricing', json: true },
      balance: 'balance', protected: 'protected', createdAt: { col: 'created_at', ro: true },
    },
    protectedDelete: true,
  },
  promotions: {
    table: 'promotions',
    fields: {
      id: 'id', name: 'name', description: 'description', active: 'active',
      startsOn: 'starts_on', endsOn: 'ends_on',
      countries: { col: 'countries', arr: true },
      audience: 'audience',
      customerIds: { col: 'customer_ids', arr: true },
      agentIds: { col: 'agent_ids', arr: true },
      minQty: 'min_qty', maxPerCustomer: 'max_per_customer', maxTotal: 'max_total',
      ctxCustomer: 'ctx_customer', ctxAgent: 'ctx_agent',
      rewardType: 'reward_type', tiers: { col: 'tiers', json: true },
      percent: 'percent', fixed: 'fixed', usedCount: 'used_count',
      createdAt: { col: 'created_at', ro: true },
    },
  },
  purchaseOrders: {
    table: 'purchase_orders',
    fields: {
      id: 'id', number: 'number', supplier: 'supplier', status: 'status',
      notes: 'notes', expectedOn: 'expected_on', items: { col: 'items', json: true },
      createdAt: { col: 'created_at', ro: true },
    },
    sequence: { name: 'po_number_seq', numberKey: 'number', prefix: 'PO' },
  },
  campaigns: {
    table: 'campaigns',
    fields: { id: 'id', name: 'name', data: { col: 'data', json: true },
              createdAt: { col: 'created_at', ro: true } },
  },
  invoices: {
    table: 'invoices',
    fields: {
      id: 'id', number: 'number', orderId: 'order_id', orderNumber: 'order_number',
      customerId: 'customer_id', amount: 'amount', provider: 'provider',
      status: 'status', issuedOn: 'issued_on', createdAt: { col: 'created_at', ro: true },
    },
    sequence: { name: 'invoice_number_seq', numberKey: 'number', prefix: 'IN' },
  },
  payments: {
    table: 'payments',
    fields: {
      id: 'id', customerId: 'customer_id', amount: 'amount', method: 'method',
      reference: 'reference', paidOn: 'paid_on',
      stripePaymentIntent: 'stripe_payment_intent',
      createdAt: { col: 'created_at', ro: true },
    },
  },
  creditNotes: {
    table: 'credit_notes',
    fields: {
      id: 'id', customerId: 'customer_id', amount: 'amount', reason: 'reason',
      issuedOn: 'issued_on', createdAt: { col: 'created_at', ro: true },
    },
  },
  collectionFlags: {
    table: 'collection_flags',
    fields: {
      id: 'id', customerId: 'customer_id', status: 'status', auto: 'auto',
      notes: 'notes', daysOverdue: 'days_overdue', lastPayment: 'last_payment',
      log: { col: 'log', json: true }, createdAt: { col: 'created_at', ro: true },
    },
  },
  shippingRules: {
    table: 'shipping_rules',
    fields: { id: 'id', country: 'country', threshold: 'threshold', cost: 'cost', active: 'active' },
  },
  freeShipping: {
    table: 'free_shipping',
    fields: { id: 'id', customerId: 'customer_id', dayOfWeek: 'day_of_week', active: 'active' },
  },
  leads: {
    table: 'leads',
    fields: {
      id: 'id', business: 'business', email: 'email', contact: 'contact', phone: 'phone',
      city: 'city', agentId: 'agent_id', rating: 'rating', stage: 'stage',
      questionnaire: { col: 'questionnaire', json: true },
      visits: { col: 'visits', json: true },
      customerId: 'customer_id', createdAt: { col: 'created_at', ro: true },
    },
  },
  chains: {
    table: 'chains',
    fields: { id: 'id', name: 'name', ownerId: 'owner_id',
              branchIds: { col: 'branch_ids', arr: true },
              createdAt: { col: 'created_at', ro: true } },
  },
  suitcases: {
    table: 'suitcases',
    fields: { id: 'id', agentId: 'agent_id', name: 'name',
              trays: { col: 'trays', json: true },
              createdAt: { col: 'created_at', ro: true } },
  },
  spareParts: {
    // Customer-submitted spare-part requests (storefront). Admin reads them and
    // moves status forward; customers create them, admin never deletes them.
    table: 'spare_parts',
    fields: { id: 'id', userId: 'user_id', model: 'model', part: 'part',
              notes: 'notes', image: 'image', status: 'status',
              createdAt: { col: 'created_at', ro: true } },
  },
  emailTemplates: {
    table: 'email_templates',
    fields: {
      id: 'id', name: 'name', language: 'language', purpose: 'purpose',
      subject: 'subject', body: 'body', isDefault: 'is_default',
      createdAt: { col: 'created_at', ro: true },
    },
  },
  tasks: {
    table: 'tasks',
    fields: {
      id: 'id', subject: 'subject', assignedTo: 'assigned_to', createdBy: 'created_by',
      status: 'status', messages: { col: 'messages', json: true },
      createdAt: { col: 'created_at', ro: true },
    },
  },
  audit: {
    table: 'audit_log',
    appendOnly: true,
    fields: {
      id: 'id', actorId: 'actor_id', actorName: 'actor_name', actorRole: 'actor_role',
      action: 'action', target: 'target', source: 'source', changes: 'changes',
      undone: 'undone', when: { col: 'created_at' },
    },
  },
};

/** row (db) -> admin JSON object, using a collection's field map. */
export function rowToJs(cfg, row) {
  const out = {};
  for (const [jsKey, def] of Object.entries(cfg.fields)) {
    const col = typeof def === 'string' ? def : def.col;
    out[jsKey] = row[col] ?? null;
  }
  return out;
}

/** admin JSON object -> {cols, vals} for insert/upsert. Unknown keys ignored. */
export function jsToRow(cfg, obj) {
  const cols = [];
  const vals = [];
  for (const [jsKey, def] of Object.entries(cfg.fields)) {
    if (!(jsKey in obj)) continue;
    const d = typeof def === 'string' ? { col: def } : def;
    if (d.ro) continue;                       // read-only (server-managed)
    let v = obj[jsKey];
    if (d.json) v = v == null ? null : JSON.stringify(v);
    if (d.arr) v = Array.isArray(v) ? v : [];
    if (v === undefined) v = null;
    cols.push(d.col);
    vals.push(v);
  }
  return { cols, vals };
}
