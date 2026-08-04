/* Palette lifted from the storefront's css/store.css so the app and the web
   portal read as one product. Keep the two in sync when either changes. */

export const colors = {
  ink: '#221F20',
  accent: '#324264',
  muted: '#64748b',
  line: '#e2e8f0',
  bg: '#fafbfc',
  card: '#ffffff',
  softBlue: '#ebf3f9',
  ok: '#15803d',
  warn: '#b45309',
  bad: '#b91c1c',
  white: '#ffffff',
};

export const radius = 10;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
};

export const text = {
  title: { fontSize: 22, fontWeight: '700' as const, color: colors.ink },
  heading: { fontSize: 17, fontWeight: '600' as const, color: colors.ink },
  body: { fontSize: 15, color: colors.ink },
  small: { fontSize: 13, color: colors.muted },
  tiny: { fontSize: 11, color: colors.muted },
};
