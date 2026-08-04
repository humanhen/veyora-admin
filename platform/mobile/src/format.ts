/* Mirrors the storefront's ui.js helpers so the app and the web portal format
   money and dates identically. */

export type Fx = { currency: string; rate: number; symbol: string };

export const DEFAULT_FX: Fx = { currency: 'USD', rate: 1, symbol: '$' };

/** Prices are stored in the base currency (USD) and converted for display to
    the account's operating currency. USD accounts get rate 1 / '$', so this is
    a no-op until an account is set to CAD/EUR. */
export function money(n: number | null | undefined, fx: Fx = DEFAULT_FX): string {
  if (n == null) return '—';
  const v = Number(n) * (Number(fx.rate) || 1);
  return (fx.symbol || '$') + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const x = new Date(d);
  return Number.isNaN(x.getTime())
    ? String(d).slice(0, 10)
    : x.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return String(d);
  return x.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
