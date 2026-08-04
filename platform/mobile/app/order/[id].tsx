import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

import { orders as ordersApi, type Order } from '../../src/api';
import { useSession } from '../../src/session';
import { fmtDate, money } from '../../src/format';
import { Card, EmptyState, Loading, StatusChip } from '../../src/components/ui';
import { colors, spacing, text } from '../../src/theme';

export default function OrderDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user, fx } = useSession();

  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    ordersApi
      .detail(id)
      .then((d) => setOrder(d.order))
      .catch(() => setOrder(null))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <Loading />;
  if (!order) return <EmptyState title="Order not found" />;

  const hidePrices = !!user?.hidePrices;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
      <View>
        <Text style={text.title}>{order.number}</Text>
        <Text style={text.small}>{fmtDate(order.date ?? order.createdAt)}</Text>
        <View style={{ marginTop: spacing.xs }}>
          <StatusChip status={order.status} />
        </View>
      </View>

      {!!order.tracking && (
        <Card>
          <Text style={text.small}>Tracking</Text>
          <Text style={text.body}>{order.tracking}</Text>
        </Card>
      )}

      <Text style={text.heading}>Items</Text>
      {(order.items ?? []).map((it) => (
        <Card key={it.id}>
          <View style={styles.itemRow}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={text.body}>{it.name ?? it.sku}</Text>
              <Text style={text.tiny}>{[it.color, it.sku].filter(Boolean).join(' · ')}</Text>
              <Text style={text.tiny}>
                Ordered {it.qty}
                {/* `collected` is what actually shipped — the number the whole
                    supplier-reconciliation model hangs off. Worth showing when
                    it differs from what was ordered. */}
                {it.collected != null && it.collected !== it.qty ? ` · shipped ${it.collected}` : ''}
              </Text>
            </View>
            {!hidePrices && it.price != null && (
              <Text style={text.body}>{money(it.price * it.qty, fx)}</Text>
            )}
          </View>
        </Card>
      ))}

      {!hidePrices && (
        <Card>
          {order.discount != null && Number(order.discount) > 0 && (
            <View style={styles.totalRow}>
              <Text style={text.small}>Discount</Text>
              <Text style={{ color: colors.ok }}>−{money(order.discount, fx)}</Text>
            </View>
          )}
          {order.shipping != null && (
            <View style={styles.totalRow}>
              <Text style={text.small}>Shipping</Text>
              <Text style={text.body}>{money(order.shipping, fx)}</Text>
            </View>
          )}
          <View style={styles.totalRow}>
            <Text style={text.heading}>Total</Text>
            <Text style={styles.total}>{money(order.total, fx)}</Text>
          </View>
        </Card>
      )}

      {!!order.comments && (
        <Card>
          <Text style={text.small}>Notes</Text>
          <Text style={text.body}>{order.comments}</Text>
        </Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  itemRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 2,
  },
  total: { fontSize: 18, fontWeight: '700', color: colors.ink },
});
