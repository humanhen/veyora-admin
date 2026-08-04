/* One shared cart so the tab badge, the product screen and the cart screen
   never disagree. Every mutating endpoint returns the whole summary, so the
   store just adopts whatever the server last said — no local reconciliation. */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { cart as cartApi, type CartSummary } from './api';
import { useSession } from './session';

type CartState = {
  summary: CartSummary | null;
  loading: boolean;
  count: number;
  refresh: () => Promise<void>;
  add: (sku: string, qty: number) => Promise<void>;
  remove: (sku: string) => Promise<void>;
};

const CartContext = createContext<CartState | null>(null);

export function CartProvider({ children }: { children: React.ReactNode }) {
  const { user } = useSession();
  const [summary, setSummary] = useState<CartSummary | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      setSummary(await cartApi.get());
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (user) void refresh();
    else setSummary(null);
  }, [user, refresh]);

  const add = useCallback(async (sku: string, qty: number) => {
    setSummary(await cartApi.add(sku, qty));
  }, []);

  const remove = useCallback(async (sku: string) => {
    setSummary(await cartApi.remove(sku));
  }, []);

  const value = useMemo(
    () => ({ summary, loading, count: summary?.totalQty ?? 0, refresh, add, remove }),
    [summary, loading, refresh, add, remove]
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used inside <CartProvider>');
  return ctx;
}
