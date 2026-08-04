import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { colors, radius, spacing, text } from '../theme';

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const isPrimary = variant === 'primary';
  const isGhost = variant === 'ghost';
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        isPrimary && styles.buttonPrimary,
        variant === 'secondary' && styles.buttonSecondary,
        isGhost && styles.buttonGhost,
        (disabled || loading) && styles.buttonDisabled,
        pressed && styles.buttonPressed,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={isPrimary ? colors.white : colors.ink} />
      ) : (
        <Text style={[styles.buttonText, isPrimary && styles.buttonTextPrimary]}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function StockPill({ qty, stockStatus }: { qty: number; stockStatus?: string | null }) {
  // Matches the storefront rule (ui.js stockPill): availability only, never the
  // number — the business explicitly asked for no quantities anywhere.
  const inStock = qty > 0;
  const inProduction = !inStock && stockStatus === 'in production';
  const label = inStock ? 'in stock' : inProduction ? 'in production' : 'out of stock';
  const tone = inStock ? colors.ok : inProduction ? colors.warn : colors.bad;
  return (
    <View style={[styles.pill, { borderColor: tone }]}>
      <Text style={[styles.pillText, { color: tone }]}>{label}</Text>
    </View>
  );
}

export function StatusChip({ status }: { status: string }) {
  const tone =
    status === 'cancelled' ? colors.bad : status === 'shipped' ? colors.ok : colors.accent;
  return (
    <View style={[styles.pill, { borderColor: tone, marginTop: 2 }]}>
      <Text style={[styles.pillText, { color: tone }]}>{status}</Text>
    </View>
  );
}

export function Loading({ label }: { label?: string }) {
  return (
    <View style={styles.centered}>
      <ActivityIndicator color={colors.accent} />
      {!!label && <Text style={[text.small, { marginTop: spacing.sm }]}>{label}</Text>}
    </View>
  );
}

export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <View style={styles.centered}>
      <Text style={text.heading}>{title}</Text>
      {!!body && (
        <Text style={[text.small, { marginTop: spacing.xs, textAlign: 'center' }]}>{body}</Text>
      )}
    </View>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <View style={styles.errorNote}>
      <Text style={{ color: colors.bad, fontSize: 13 }}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 46,
    borderRadius: radius,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderColor: colors.line,
  },
  buttonPrimary: { backgroundColor: colors.ink, borderColor: colors.ink },
  buttonSecondary: { backgroundColor: colors.white },
  buttonGhost: { backgroundColor: 'transparent', borderColor: 'transparent' },
  buttonDisabled: { opacity: 0.5 },
  buttonPressed: { opacity: 0.8 },
  buttonText: { fontSize: 15, fontWeight: '600', color: colors.ink },
  buttonTextPrimary: { color: colors.white },

  card: {
    backgroundColor: colors.card,
    borderRadius: radius,
    borderWidth: 1,
    borderColor: colors.line,
    padding: spacing.lg,
  },

  pill: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  pillText: { fontSize: 11, fontWeight: '600' },

  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },

  errorNote: {
    backgroundColor: '#fef2f2',
    borderColor: '#fecaca',
    borderWidth: 1,
    borderRadius: radius,
    padding: spacing.md,
  },
});
