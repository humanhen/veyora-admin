import React from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useSession } from '../../src/session';
import { useAppUpdates } from '../../src/updates';
import { BASE_URL } from '../../src/api';
import { money } from '../../src/format';
import { Button, Card } from '../../src/components/ui';
import { colors, radius, spacing, text } from '../../src/theme';

const WHATSAPP_NUMBER = '16467731000';

export default function AccountScreen() {
  const { user, fx, signOut } = useSession();
  const { otaReady, binaryUpdateAvailable, info } = useAppUpdates();
  const router = useRouter();

  const confirmSignOut = () =>
    Alert.alert('Sign out', 'Sign out of Veyora on this device?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void signOut() },
    ]);

  // Mirrors the storefront's WhatsApp float: the message identifies the
  // customer so support knows who they're talking to.
  const whatsapp = () => {
    const who = user?.business ?? user?.email ?? '';
    const num = user?.customerNumber ? ` (customer #${user.customerNumber})` : '';
    const msg = encodeURIComponent(`Hi, it's ${who}${num}`);
    void Linking.openURL(`https://wa.me/${WHATSAPP_NUMBER}?text=${msg}`);
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
        <Text style={text.title}>Account</Text>

        <Card style={{ gap: spacing.xs }}>
          <Text style={text.heading}>{user?.business ?? '—'}</Text>
          <Text style={text.small}>{user?.email}</Text>
          {user?.customerNumber != null && (
            <Text style={text.tiny}>Customer #{user.customerNumber}</Text>
          )}
          {!user?.hidePrices && user?.balance != null && (
            <Text style={[text.small, { marginTop: spacing.xs }]}>
              Balance {money(user.balance, fx)}
            </Text>
          )}
          {!!user?.paymentTerms && <Text style={text.tiny}>Terms: {user.paymentTerms}</Text>}
        </Card>

        <Row
          icon="logo-whatsapp"
          label="Contact Veyora"
          detail="WhatsApp"
          onPress={whatsapp}
        />
        <Row
          icon="globe-outline"
          label="Open the full site"
          detail={BASE_URL.replace(/^https?:\/\//, '')}
          onPress={() => void Linking.openURL(BASE_URL)}
        />
        <Row
          icon="cloud-download-outline"
          label="App version"
          detail={
            otaReady
              ? 'Update ready'
              : binaryUpdateAvailable
                ? 'New build available'
                : `${info.appVersion} (${info.buildNumber ?? '—'})`
          }
          badge={otaReady || binaryUpdateAvailable}
          onPress={() => router.push('/settings/updates')}
        />

        <Button
          title="Sign out"
          variant="secondary"
          onPress={confirmSignOut}
          style={{ marginTop: spacing.lg }}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({
  icon,
  label,
  detail,
  badge,
  onPress,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  detail?: string;
  badge?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <Ionicons name={icon} size={20} color={colors.accent} />
      <Text style={[text.body, { flex: 1 }]}>{label}</Text>
      {!!detail && <Text style={text.small}>{detail}</Text>}
      {badge && <View style={styles.dot} />}
      <Ionicons name="chevron-forward" size={18} color={colors.muted} />
    </Pressable>
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
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent },
});
