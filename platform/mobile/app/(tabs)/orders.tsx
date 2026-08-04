import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { orders as ordersApi, type Order } from '../../src/api';
import { useSession } from '../../src/session';
import { fmtDate, money } from '../../src/format';
import { EmptyState, Loading, StatusChip } from '../../src/components/ui';
import { colors, radius, spacing, text } from '../../src/theme';

const PER_PAGE = 20;

export default function OrdersScreen() {
  const { user, fx } = useSession();
  const router = useRouter();

  const [items, setItems] = useState<Order[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (nextPage: number) => {
    try {
      const data = await ordersApi.list(nextPage, PER_PAGE);
      setItems((prev) => (nextPage === 1 ? data.orders : [...prev, ...data.orders]));
      setTotal(Number(data.total) || 0);
      setPage(nextPage);
    } catch {
      if (nextPage === 1) setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(1);
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(1);
    setRefreshing(false);
  }, [load]);

  if (loading) return <Loading />;

  const hidePrices = !!user?.hidePrices;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <FlatList
        data={items}
        keyExtractor={(o) => o.id}
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListHeaderComponent={<Text style={[text.title, { marginBottom: spacing.sm }]}>Orders</Text>}
        ListEmptyComponent={<EmptyState title="No orders yet" />}
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          if (items.length < total) void load(page + 1);
        }}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => router.push(`/order/${item.id}`)}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={text.heading}>{item.number}</Text>
              <Text style={text.tiny}>
                {fmtDate(item.date ?? item.createdAt)}
                {item.itemCount != null ? ` · ${item.itemCount} items` : ''}
              </Text>
              <StatusChip status={item.status} />
            </View>
            {!hidePrices && <Text style={text.body}>{money(item.total, fx)}</Text>}
            <Ionicons name="chevron-forward" size={18} color={colors.muted} />
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius,
    padding: spacing.md,
  },
});
