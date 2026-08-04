import React, { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { cart as cartApi, imageUrl, type CartItem } from '../../src/api';
import { useCart } from '../../src/cartStore';
import { useSession } from '../../src/session';
import { money } from '../../src/format';
import { Button, EmptyState, ErrorNote, Loading } from '../../src/components/ui';
import { colors, radius, spacing, text } from '../../src/theme';

export default function CartScreen() {
  const { summary, loading, refresh, add, remove } = useCart();
  const { user, fx } = useSession();
  const router = useRouter();

  const [refreshing, setRefreshing] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  const placeOrder = useCallback(() => {
    Alert.alert('Place order', 'Submit this cart as an order?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Place order',
        style: 'default',
        onPress: async () => {
          setPlacing(true);
          setError(null);
          try {
            await cartApi.placeOrder();
            await refresh();
            router.push('/orders');
          } catch (e: any) {
            setError(e?.message ?? 'Could not place the order.');
          } finally {
            setPlacing(false);
          }
        },
      },
    ]);
  }, [refresh, router]);

  if (loading && !summary) return <Loading />;

  const items = summary?.items ?? [];
  const hidePrices = !!user?.hidePrices;

  if (items.length === 0) {
    return (
      <SafeAreaView style={styles.screen} edges={['top']}>
        <EmptyState title="Your cart is empty" body="Browse the catalogue to add frames." />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm, paddingBottom: 180 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListHeaderComponent={<Text style={[text.title, { marginBottom: spacing.sm }]}>Cart</Text>}
        renderItem={({ item }) => (
          <Row
            item={item}
            hidePrices={hidePrices}
            fx={fx}
            onQty={(q) => add(item.sku, q)}
            onRemove={() => remove(item.sku)}
          />
        )}
      />

      <View style={styles.footer}>
        {!!error && <ErrorNote message={error} />}
        {!hidePrices && (
          <>
            <View style={styles.totalRow}>
              <Text style={text.small}>Subtotal</Text>
              <Text style={text.body}>{money(summary?.subtotal, fx)}</Text>
            </View>
            {!!summary?.promotion && (
              <View style={styles.totalRow}>
                <Text style={[text.small, { color: colors.ok }]}>
                  {summary.promotion.name ?? 'Promotion'}
                </Text>
                <Text style={{ color: colors.ok }}>−{money(summary.promotion.discount, fx)}</Text>
              </View>
            )}
            <View style={styles.totalRow}>
              <Text style={text.heading}>Total</Text>
              <Text style={styles.total}>{money(summary?.total, fx)}</Text>
            </View>
          </>
        )}
        <Button title="Place order" onPress={placeOrder} loading={placing} />
      </View>
    </SafeAreaView>
  );
}

function Row({
  item,
  hidePrices,
  fx,
  onQty,
  onRemove,
}: {
  item: CartItem;
  hidePrices: boolean;
  fx: any;
  onQty: (qty: number) => void;
  onRemove: () => void;
}) {
  const src = imageUrl(item.image);
  // The line survives its variation being deactivated (missing = true); show it
  // plainly rather than silently dropping something the customer added.
  return (
    <View style={styles.row}>
      {src ? (
        <Image source={{ uri: src }} style={styles.rowImage} contentFit="cover" />
      ) : (
        <View style={[styles.rowImage, styles.rowImageEmpty]}>
          <Text style={{ color: colors.muted }}>∞</Text>
        </View>
      )}

      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={text.heading}>
          {item.name ?? item.sku}
        </Text>
        <Text numberOfLines={1} style={text.tiny}>
          {[item.color, item.sku].filter(Boolean).join(' · ')}
        </Text>
        {item.missing && (
          <Text style={{ color: colors.bad, fontSize: 12 }}>No longer available</Text>
        )}
        {!item.missing && item.available < item.qty && (
          <Text style={{ color: colors.warn, fontSize: 12 }}>
            Part of this line will be backordered
          </Text>
        )}

        <View style={styles.rowFooter}>
          <View style={styles.qtyBox}>
            <Pressable
              onPress={() => onQty(Math.max(1, item.qty - 1))}
              hitSlop={8}
              style={styles.qtyBtn}
            >
              <Text style={styles.qtyBtnText}>−</Text>
            </Pressable>
            <Text style={styles.qtyValue}>{item.qty}</Text>
            <Pressable onPress={() => onQty(item.qty + 1)} hitSlop={8} style={styles.qtyBtn}>
              <Text style={styles.qtyBtnText}>+</Text>
            </Pressable>
          </View>
          {!hidePrices && <Text style={text.body}>{money(item.lineTotal, fx)}</Text>}
        </View>
      </View>

      <Pressable onPress={onRemove} hitSlop={8} style={{ padding: spacing.xs }}>
        <Ionicons name="trash-outline" size={18} color={colors.muted} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  row: {
    flexDirection: 'row',
    gap: spacing.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius,
    padding: spacing.sm,
  },
  rowImage: { width: 64, height: 64, borderRadius: radius - 2, backgroundColor: colors.bg },
  rowImageEmpty: { alignItems: 'center', justifyContent: 'center' },
  rowFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
  },
  qtyBox: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius,
  },
  qtyBtn: { paddingHorizontal: spacing.sm, paddingVertical: 2 },
  qtyBtnText: { fontSize: 17, color: colors.ink },
  qtyValue: { minWidth: 24, textAlign: 'center', fontSize: 14, color: colors.ink },

  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: spacing.lg,
    paddingBottom: spacing.xl + spacing.sm,
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  total: { fontSize: 18, fontWeight: '700', color: colors.ink },
});
