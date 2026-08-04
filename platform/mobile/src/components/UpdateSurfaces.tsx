/* The two places update state becomes visible to a user.

   UpdateGate is a hard stop — it renders instead of the app when the server
   says this binary is below the supported floor. There's no dismiss, because
   the whole point is that this build can't be trusted to work.

   UpdateBanner is the soft case: an OTA update is already downloaded and just
   needs a reload. It's a strip, not a modal, because nothing is broken — the
   user can finish what they're doing and restart when convenient. */

import React, { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, radius, spacing, text } from '../theme';
import { Button } from './ui';
import { useAppUpdates } from '../updates';

export function UpdateGate({ children }: { children: React.ReactNode }) {
  const { mustUpdateBinary, appConfig } = useAppUpdates();

  if (!mustUpdateBinary) return <>{children}</>;

  const installUrl = appConfig?.installUrl;
  return (
    <SafeAreaView style={styles.gate}>
      <View style={styles.gateInner}>
        <Text style={styles.gateTitle}>Update required</Text>
        <Text style={styles.gateBody}>
          {appConfig?.message ??
            'This version of Veyora is no longer supported. Install the latest build to carry on.'}
        </Text>
        {!!installUrl && (
          <Button
            title="Get the latest build"
            onPress={() => Linking.openURL(installUrl)}
            style={{ marginTop: spacing.xl, alignSelf: 'stretch' }}
          />
        )}
      </View>
    </SafeAreaView>
  );
}

export function UpdateBanner() {
  const { otaReady, applyOtaUpdate } = useAppUpdates();
  const [dismissed, setDismissed] = useState(false);
  const [restarting, setRestarting] = useState(false);

  if (!otaReady || dismissed) return null;

  return (
    <View style={styles.banner}>
      <Text style={styles.bannerText}>An update is ready.</Text>
      <View style={styles.bannerActions}>
        <Pressable
          onPress={async () => {
            setRestarting(true);
            await applyOtaUpdate();
            setRestarting(false);
          }}
          hitSlop={8}
        >
          <Text style={styles.bannerPrimary}>{restarting ? 'Restarting…' : 'Restart'}</Text>
        </Pressable>
        <Pressable onPress={() => setDismissed(true)} hitSlop={8}>
          <Text style={styles.bannerDismiss}>Later</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  gate: { flex: 1, backgroundColor: colors.ink },
  gateInner: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  gateTitle: { fontSize: 22, fontWeight: '700', color: colors.white, marginBottom: spacing.md },
  gateBody: { fontSize: 15, color: '#cbd5e1', textAlign: 'center', lineHeight: 22 },

  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.softBlue,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  bannerText: { ...text.small, color: colors.ink, flexShrink: 1 },
  bannerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  bannerPrimary: { fontSize: 13, fontWeight: '700', color: colors.accent },
  bannerDismiss: { fontSize: 13, color: colors.muted },
});
