import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Dimensions,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { useLocalSearchParams } from 'expo-router';

import { catalog, imageUrl, type Product, type Variation } from '../../src/api';
import { useSession } from '../../src/session';
import { useCart } from '../../src/cartStore';
import { money } from '../../src/format';
import { Button, Card, EmptyState, Loading, StockPill } from '../../src/components/ui';
import { colors, radius, spacing, text } from '../../src/theme';

export default function ProductScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user, fx } = useSession();
  const { add } = useCart();

  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedSku, setSelectedSku] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);

  useEffect(() => {
    if (!id) return;
    catalog
      .product(id)
      .then((d) => {
        setProduct(d.product);
        setSelectedSku(d.product.variations[0]?.sku ?? null);
      })
      .catch(() => setProduct(null))
      .finally(() => setLoading(false));
  }, [id]);

  const selected: Variation | null = useMemo(
    () => product?.variations.find((v) => v.sku === selectedSku) ?? null,
    [product, selectedSku]
  );

  // The gallery is the product's own shots plus every colourway that has its
  // own photo — same merge the web modal does.
  const gallery = useMemo(() => {
    if (!product) return [];
    const fromVariations = product.variations.map((v) => v.image).filter(Boolean) as string[];
    return [...new Set([...(product.images ?? []), ...fromVariations])];
  }, [product]);

  // Picking a colour jumps the gallery to that colour's shot, if it has one.
  const [heroIndex, setHeroIndex] = useState(0);
  useEffect(() => {
    if (!selected?.image) return;
    const idx = gallery.indexOf(selected.image);
    if (idx >= 0) setHeroIndex(idx);
  }, [selected, gallery]);

  const onAdd = useCallback(async () => {
    if (!selected || adding) return;
    setAdding(true);
    try {
      await add(selected.sku, qty);
      setAdded(true);
      setTimeout(() => setAdded(false), 2000);
    } finally {
      setAdding(false);
    }
  }, [selected, qty, add, adding]);

  if (loading) return <Loading />;
  if (!product) return <EmptyState title="Product not found" />;

  const hidePrices = !!user?.hidePrices;
  const price = selected?.price ?? product.price;
  const canOrder = !!selected && selected.qty > 0;

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={{ paddingBottom: 120 }}>
        <View style={styles.hero}>
          {gallery.length > 0 ? (
            <Image
              source={{ uri: imageUrl(gallery[heroIndex]) ?? undefined }}
              style={styles.heroImage}
              contentFit="contain"
              transition={150}
            />
          ) : (
            <View style={[styles.heroImage, styles.heroEmpty]}>
              <Text style={{ color: colors.muted, fontSize: 40 }}>∞</Text>
            </View>
          )}
        </View>

        {gallery.length > 1 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.thumbs}
          >
            {gallery.map((src, i) => (
              <Pressable key={src + i} onPress={() => setHeroIndex(i)}>
                <Image
                  source={{ uri: imageUrl(src) ?? undefined }}
                  style={[styles.thumb, i === heroIndex && styles.thumbActive]}
                  contentFit="cover"
                />
              </Pressable>
            ))}
          </ScrollView>
        )}

        <View style={styles.body}>
          <Text style={text.title}>{product.name}</Text>
          <Text style={[text.small, { marginTop: 2 }]}>
            {[product.brand, product.sku, product.size].filter(Boolean).join(' · ')}
          </Text>

          {!hidePrices && price != null && <Text style={styles.price}>{money(price, fx)}</Text>}

          {product.variations.length > 0 && (
            <>
              <Text style={[text.heading, { marginTop: spacing.lg, marginBottom: spacing.sm }]}>
                Colour
              </Text>
              <View style={styles.colors}>
                {product.variations.map((v) => {
                  const active = v.sku === selectedSku;
                  return (
                    <Pressable
                      key={v.sku}
                      onPress={() => {
                        setSelectedSku(v.sku);
                        setQty(1);
                      }}
                      style={[styles.color, active && styles.colorActive]}
                    >
                      <Text style={[styles.colorText, active && styles.colorTextActive]}>
                        {v.color || v.sku}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          )}

          {!!selected && (
            <View style={{ marginTop: spacing.md }}>
              <StockPill qty={selected.qty} stockStatus={selected.stockStatus} />
            </View>
          )}

          {!!product.description && (
            <Card style={{ marginTop: spacing.lg }}>
              <Text style={text.body}>{product.description}</Text>
            </Card>
          )}
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <View style={styles.qtyBox}>
          <Pressable onPress={() => setQty((q) => Math.max(1, q - 1))} hitSlop={8} style={styles.qtyBtn}>
            <Text style={styles.qtyBtnText}>−</Text>
          </Pressable>
          <Text style={styles.qtyValue}>{qty}</Text>
          <Pressable onPress={() => setQty((q) => q + 1)} hitSlop={8} style={styles.qtyBtn}>
            <Text style={styles.qtyBtnText}>+</Text>
          </Pressable>
        </View>
        <Button
          title={added ? 'Added ✓' : canOrder ? 'Add to cart' : 'Out of stock'}
          onPress={onAdd}
          loading={adding}
          disabled={!canOrder}
          style={{ flex: 1 }}
        />
      </View>
    </View>
  );
}

const { width } = Dimensions.get('window');

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  hero: { backgroundColor: colors.white },
  heroImage: { width, height: width, backgroundColor: colors.white },
  heroEmpty: { alignItems: 'center', justifyContent: 'center' },
  thumbs: { gap: spacing.sm, padding: spacing.md },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: radius - 2,
    borderWidth: 2,
    borderColor: 'transparent',
    backgroundColor: colors.white,
  },
  thumbActive: { borderColor: colors.ink },
  body: { padding: spacing.lg },
  price: { fontSize: 24, fontWeight: '700', color: colors.ink, marginTop: spacing.md },
  colors: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  color: {
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.white,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  colorActive: { backgroundColor: colors.ink, borderColor: colors.ink },
  colorText: { fontSize: 13, color: colors.ink },
  colorTextActive: { color: colors.white, fontWeight: '600' },

  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    paddingBottom: spacing.xl + spacing.sm,
    backgroundColor: colors.white,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  qtyBox: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius,
    height: 46,
  },
  qtyBtn: { paddingHorizontal: spacing.md, height: '100%', justifyContent: 'center' },
  qtyBtnText: { fontSize: 20, color: colors.ink },
  qtyValue: { minWidth: 28, textAlign: 'center', fontSize: 15, fontWeight: '600', color: colors.ink },
});
