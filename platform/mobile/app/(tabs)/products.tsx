import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';

import { catalog, imageUrl, type Product } from '../../src/api';
import { useSession } from '../../src/session';
import { money } from '../../src/format';
import { EmptyState, Loading, StockPill } from '../../src/components/ui';
import { colors, radius, spacing, text } from '../../src/theme';

const PER_PAGE = 24;

export default function ProductsScreen() {
  const { user, fx } = useSession();
  const router = useRouter();

  const [search, setSearch] = useState('');
  const [brands, setBrands] = useState<string[]>([]);
  const [activeBrand, setActiveBrand] = useState<string | null>(null);
  const [items, setItems] = useState<Product[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // Guards against a slow page-1 response landing after a newer query and
  // overwriting it — the catalog is ~1000 products and searches race easily.
  const requestId = useRef(0);

  useEffect(() => {
    catalog
      .filterData()
      .then((d) => setBrands(d.brands ?? []))
      .catch(() => setBrands([]));
  }, []);

  const query = useMemo(
    () => ({ search: search.trim(), brands: activeBrand ? [activeBrand] : [] }),
    [search, activeBrand]
  );

  const load = useCallback(
    async (nextPage: number) => {
      const id = ++requestId.current;
      if (nextPage === 1) setLoading(true);
      else setLoadingMore(true);
      try {
        const data = await catalog.products({
          page: nextPage,
          perPage: PER_PAGE,
          sort: 'popular',
          ...query,
        });
        if (id !== requestId.current) return; // superseded
        setItems((prev) => (nextPage === 1 ? data.products : [...prev, ...data.products]));
        setHasMore(data.hasMore);
        setPage(data.page);
      } catch {
        if (id === requestId.current && nextPage === 1) setItems([]);
      } finally {
        if (id === requestId.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [query]
  );

  // Debounce so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => void load(1), 250);
    return () => clearTimeout(t);
  }, [load]);

  const hidePrices = !!user?.hidePrices;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <TextInput
          style={styles.search}
          value={search}
          onChangeText={setSearch}
          placeholder="Search model, SKU or colour"
          placeholderTextColor={colors.muted}
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
      </View>

      {brands.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
        >
          <Chip label="All" active={!activeBrand} onPress={() => setActiveBrand(null)} />
          {brands.map((b) => (
            <Chip
              key={b}
              label={b}
              active={activeBrand === b}
              onPress={() => setActiveBrand((cur) => (cur === b ? null : b))}
            />
          ))}
        </ScrollView>
      )}

      {loading ? (
        <Loading />
      ) : items.length === 0 ? (
        <EmptyState title="Nothing found" body="Try a different search or clear the filters." />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(p) => p.id}
          numColumns={2}
          columnWrapperStyle={{ gap: spacing.sm, paddingHorizontal: spacing.lg }}
          contentContainerStyle={{ gap: spacing.sm, paddingBottom: spacing.xl }}
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (hasMore && !loadingMore) void load(page + 1);
          }}
          ListFooterComponent={
            loadingMore ? <ActivityIndicator style={{ margin: spacing.lg }} color={colors.accent} /> : null
          }
          renderItem={({ item }) => (
            <ProductCard
              product={item}
              hidePrices={hidePrices}
              fx={fx}
              onPress={() => router.push(`/product/${item.id}`)}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

function ProductCard({
  product,
  hidePrices,
  fx,
  onPress,
}: {
  product: Product;
  hidePrices: boolean;
  fx: any;
  onPress: () => void;
}) {
  // A card shows the product photo, falling back to the first colourway that
  // has one — the same rule the web grid uses.
  const src = imageUrl(product.images?.[0] ?? product.variations.find((v) => v.image)?.image);

  return (
    <Pressable style={styles.card} onPress={onPress}>
      <View style={styles.thumbWrap}>
        {src ? (
          <Image source={{ uri: src }} style={styles.thumb} contentFit="cover" transition={120} />
        ) : (
          <View style={[styles.thumb, styles.thumbEmpty]}>
            <Text style={{ color: colors.muted, fontSize: 22 }}>∞</Text>
          </View>
        )}
      </View>
      <Text numberOfLines={1} style={styles.cardTitle}>
        {product.name}
      </Text>
      <Text numberOfLines={1} style={text.tiny}>
        {product.brand}
      </Text>
      <View style={styles.cardFooter}>
        <StockPill qty={product.qty} />
        {!hidePrices && product.price != null && (
          <Text style={styles.price}>{money(product.price, fx)}</Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { padding: spacing.lg, paddingBottom: spacing.sm },
  search: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius,
    paddingHorizontal: spacing.md,
    minHeight: 42,
    fontSize: 15,
    color: colors.ink,
  },
  chips: { paddingHorizontal: spacing.lg, gap: spacing.sm, paddingBottom: spacing.md },
  chip: {
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.white,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  chipActive: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { fontSize: 13, color: colors.ink },
  chipTextActive: { color: colors.white, fontWeight: '600' },

  card: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: radius,
    borderWidth: 1,
    borderColor: colors.line,
    padding: spacing.sm,
    gap: 2,
  },
  thumbWrap: { borderRadius: radius - 2, overflow: 'hidden', marginBottom: spacing.xs },
  thumb: { width: '100%', aspectRatio: 1, backgroundColor: colors.bg },
  thumbEmpty: { alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: 14, fontWeight: '600', color: colors.ink },
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
  },
  price: { fontSize: 14, fontWeight: '700', color: colors.ink },
});
