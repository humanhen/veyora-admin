/* The version screen a tester lands on when something looks wrong.

   It answers three questions: what exactly is running (so a bug report is
   actionable), is there anything newer, and can I get it right now. */

import React, { useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAppUpdates } from '../../src/updates';
import { fmtDateTime } from '../../src/format';
import { Button, Card, ErrorNote } from '../../src/components/ui';
import { colors, spacing, text } from '../../src/theme';

export default function UpdatesScreen() {
  const {
    otaReady,
    otaAvailable,
    checking,
    downloading,
    lastCheckedAt,
    error,
    binaryUpdateAvailable,
    appConfig,
    info,
    check,
    applyOtaUpdate,
  } = useAppUpdates();

  const [restarting, setRestarting] = useState(false);

  const status = otaReady
    ? 'An update is downloaded and ready to apply.'
    : downloading
      ? 'Downloading an update…'
      : otaAvailable
        ? 'An update is available.'
        : checking
          ? 'Checking…'
          : info.otaEnabled
            ? 'You are on the latest version.'
            : 'Over-the-air updates are off in this build (development client).';

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Card style={{ gap: spacing.sm }}>
        <Text style={text.heading}>{status}</Text>
        {!!lastCheckedAt && <Text style={text.tiny}>Last checked {fmtDateTime(lastCheckedAt)}</Text>}

        {!!error && <ErrorNote message={error} />}

        {otaReady && (
          <Button
            title={restarting ? 'Restarting…' : 'Restart to apply'}
            onPress={async () => {
              setRestarting(true);
              await applyOtaUpdate();
              setRestarting(false);
            }}
            loading={restarting}
          />
        )}

        <Button
          title="Check for updates"
          variant="secondary"
          onPress={() => void check()}
          loading={checking || downloading}
        />
      </Card>

      {binaryUpdateAvailable && (
        <Card style={{ gap: spacing.sm, borderColor: colors.accent }}>
          <Text style={text.heading}>A new build is available</Text>
          <Text style={text.small}>
            {appConfig?.message ??
              'This one still works, but the newest build has changes that can only ship in a full release.'}
          </Text>
          {!!appConfig?.installUrl && (
            <Button
              title="Open TestFlight"
              onPress={() => void Linking.openURL(appConfig.installUrl!)}
            />
          )}
        </Card>
      )}

      <Text style={[text.heading, { marginTop: spacing.md }]}>This build</Text>
      <Card>
        <Detail label="Version" value={info.appVersion} />
        <Detail label="Build" value={info.buildNumber ?? '—'} />
        <Detail label="Runtime" value={info.runtimeVersion ?? '—'} />
        <Detail label="Channel" value={info.channel ?? '—'} />
        <Detail
          label="Update"
          // An embedded launch means it's running the JS that shipped inside the
          // binary — no OTA update has been applied on top.
          value={info.isEmbedded ? 'Bundled with the build' : (info.updateId ?? '—')}
        />
        {!info.isEmbedded && !!info.updateCreatedAt && (
          <Detail label="Published" value={fmtDateTime(info.updateCreatedAt)} />
        )}
      </Card>

      <Text style={[text.tiny, { marginTop: spacing.md }]}>
        Most changes arrive automatically the next time you open the app. A new build is only needed
        when the update says so.
      </Text>
    </ScrollView>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detail}>
      <Text style={text.small}>{label}</Text>
      <Text style={styles.detailValue} numberOfLines={1} selectable>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.md },
  detail: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.lg,
    paddingVertical: 4,
  },
  detailValue: { fontSize: 13, color: colors.ink, flexShrink: 1, textAlign: 'right' },
});
