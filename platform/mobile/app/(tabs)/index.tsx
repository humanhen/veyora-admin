import React, { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useSession } from '../../src/session';
import { useCart } from '../../src/cartStore';
import { orders as ordersApi, type Order } from '../../src/api';
import { money } from '../../src/format';
import { Card, Loading } from '../../src/components/ui';
import { colors, radius, spacing, text } from '../../src/theme';

/** Mirrors the web dashboard's tiles (pages_dashboard.js): the numbers a
    customer opens the app to check. */
export default function DashboardScreen() {
  const { user, fx } = useSession();
  const { summary, refresh: refreshCart } = useCart();
  const router = useRouter();

  const [recent, setRecent] = useState<Order[]>([]);
  const [orderTotal, setOrderTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await ordersApi.list(1, 5);
      setRecent(data.orders ?? []);
      setOrderTotal(Number(data.total) || 0);
    } catch {
      setRecent([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([load(), refreshCart()]);
    setRefreshing(false);
  }, [load, refreshCart]);

  if (loading) return <Loading />;

  const hidePrices = !!user?.hidePrices;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <Text style={text.title}>
          {user?.business || [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Welcome'}
        </Text>
        <Text style={[text.small, { marginBottom: spacing.lg }]}>
          Manage your orders, account, and explore our latest products.
        </Text>

        <View style={styles.tiles}>
          <Tile
            icon="bag-outline"
            label="Total orders"
            value={orderTotal == null ? '—' : String(orderTotal)}
            onPress={() => router.push('/orders')}
          />
          <Tile
            icon="cart-outline"
            label="Items in cart"
            value={String(summary?.totalQty ?? 0)}
            onPress={() => router.push('/cart')}
          />
          {!hidePrices && (
            <Tile
              icon="cash-outline"
              label="Cart total"
              value={money(summary?.total ?? 0, fx)}
              onPress={() => router.push('/cart')}
            />
          )}
          <Tile
            icon="grid-outline"
            label="Browse"
            value="Products"
            onPress={() => router.push('/products')}
          />
        </View>

        <Text style={[text.heading, { marginTop: spacing.xl, marginBottom: spacing.sm }]}>
          Recent orders
        </Text>
        {recent.length === 0 ? (
          <Card>
            <Text style={text.small}>No orders yet.</Text>
          </Card>
        ) : (
          recent.map((o) => (
            <Card key={o.id} style={{ marginBottom: spacing.sm }}>
              <View style={styles.orderRow}>
                <View style={{ flex: 1 }}>
                  <Text style={text.heading}>{o.number}</Text>
                  <Text style={text.small}>{o.status}</Text>
                </View>
                {!hidePrices && <Text style={text.body}>{money(o.total, fx)}</Text>}
              </View>
            </Card>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Tile({
  icon,
  label,
  value,
  onPress,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  value: string;
  onPress: () => void;
}) {
  return (
    <Card style={styles.tile}>
      <View style={styles.tileIcon}>
        <Ionicons name={icon} size={18} color={colors.accent} />
      </View>
      <Text style={styles.tileValue} onPress={onPress}>
        {value}
      </Text>
      <Text style={text.small}>{label}</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: spacing.xl * 2 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tile: { flexBasis: '48%', flexGrow: 1, gap: spacing.xs },
  tileIcon: {
    width: 32,
    height: 32,
    borderRadius: radius,
    backgroundColor: colors.softBlue,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  tileValue: { fontSize: 20, fontWeight: '700', color: colors.ink },
  orderRow: { flexDirection: 'row', alignItems: 'center' },
});
