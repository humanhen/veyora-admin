/* Update management — two independent channels, deliberately.

   1. OTA (expo-updates / EAS Update). Anything that lives in the JS bundle or
      in bundled assets — screens, copy, styling, pricing logic, bug fixes —
      ships this way. No new binary, no App Store review, no TestFlight build.
      This is what keeps day-to-day changes off the build queue entirely.

   2. Native build gate (/api/app/config). Some changes OTA physically cannot
      deliver: a new native module, an Expo SDK bump, anything that changes the
      native fingerprint. Those need a real build, and older installs have to be
      told. The server owns that floor so it can be raised without a deploy.

   The runtimeVersion policy is "fingerprint" (app.json), which means EAS
   computes compatibility from the actual native layer: a JS-only change keeps
   the same fingerprint and the update is delivered; a native change produces a
   new fingerprint and older builds simply never see it. That's the safety
   property — an OTA update can't be served to a binary that can't run it. */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, type AppStateStatus, Platform } from 'react-native';
import * as Updates from 'expo-updates';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { fetchAppConfig, type AppConfig } from './api';

/** Don't re-check on every brief app switch. */
const MIN_CHECK_INTERVAL_MS = 60_000;

export type UpdateState = {
  /** An OTA update has been downloaded and will apply on reload. */
  otaReady: boolean;
  /** An OTA update exists on the server but isn't downloaded yet. */
  otaAvailable: boolean;
  checking: boolean;
  downloading: boolean;
  lastCheckedAt: Date | null;
  error: string | null;

  /** Server says this binary is too old to keep using — hard block. */
  mustUpdateBinary: boolean;
  /** Server says a newer binary exists — soft nudge. */
  binaryUpdateAvailable: boolean;
  appConfig: AppConfig | null;

  /** Identity of what's actually running, for the Settings screen and for
      bug reports from testers. */
  info: {
    appVersion: string;
    buildNumber: string | null;
    runtimeVersion: string | null;
    channel: string | null;
    updateId: string | null;
    updateCreatedAt: Date | null;
    isEmbedded: boolean;
    otaEnabled: boolean;
  };

  check: () => Promise<void>;
  applyOtaUpdate: () => Promise<void>;
};

const UpdatesContext = createContext<UpdateState | null>(null);

/** The build number of the binary itself — not the manifest's, which an OTA
    update can carry over from whenever it was published. */
function nativeBuildNumber(): number | null {
  const raw = Application.nativeBuildVersion;
  const n = raw == null ? NaN : parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : null;
}

export function UpdatesProvider({ children }: { children: React.ReactNode }) {
  const {
    isUpdateAvailable,
    isUpdatePending,
    isChecking,
    isDownloading,
    currentlyRunning,
    checkError,
    downloadError,
  } = Updates.useUpdates();

  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastCheckRef = useRef(0);

  const buildNumber = nativeBuildNumber();

  const check = useCallback(async () => {
    lastCheckRef.current = Date.now();
    setError(null);

    // The two checks are independent: a dead API shouldn't stop an OTA update
    // from landing, and OTA being disabled (dev client) shouldn't hide the
    // server's "you must update" signal.
    const [otaResult, configResult] = await Promise.allSettled([
      Updates.isEnabled ? Updates.checkForUpdateAsync() : Promise.resolve(null),
      fetchAppConfig(Platform.OS, buildNumber),
    ]);

    if (configResult.status === 'fulfilled') setAppConfig(configResult.value);

    if (otaResult.status === 'fulfilled' && otaResult.value?.isAvailable) {
      try {
        await Updates.fetchUpdateAsync();
      } catch (e: any) {
        setError(e?.message ?? 'Could not download the update.');
      }
    } else if (otaResult.status === 'rejected') {
      setError((otaResult.reason as any)?.message ?? 'Could not check for updates.');
    }

    setLastCheckedAt(new Date());
  }, [buildNumber]);

  // Check on launch, and again whenever the app comes back to the foreground —
  // that's when a tester who left the app open overnight picks up a fix.
  useEffect(() => {
    void check();
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next !== 'active') return;
      if (Date.now() - lastCheckRef.current < MIN_CHECK_INTERVAL_MS) return;
      void check();
    });
    return () => sub.remove();
  }, [check]);

  const applyOtaUpdate = useCallback(async () => {
    if (!Updates.isEnabled) return;
    try {
      if (!isUpdatePending) await Updates.fetchUpdateAsync();
      await Updates.reloadAsync();
    } catch (e: any) {
      setError(e?.message ?? 'Could not apply the update.');
    }
  }, [isUpdatePending]);

  const value = useMemo<UpdateState>(
    () => ({
      otaReady: isUpdatePending,
      otaAvailable: isUpdateAvailable,
      checking: isChecking,
      downloading: isDownloading,
      lastCheckedAt,
      error: error ?? checkError?.message ?? downloadError?.message ?? null,

      mustUpdateBinary: !!appConfig?.updateRequired,
      binaryUpdateAvailable: !!appConfig?.updateAvailable,
      appConfig,

      info: {
        appVersion: Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? '—',
        buildNumber: Application.nativeBuildVersion ?? null,
        runtimeVersion: Updates.runtimeVersion,
        channel: Updates.channel,
        updateId: Updates.updateId,
        updateCreatedAt: Updates.createdAt,
        isEmbedded: Updates.isEmbeddedLaunch,
        otaEnabled: Updates.isEnabled,
      },

      check,
      applyOtaUpdate,
    }),
    [
      isUpdatePending,
      isUpdateAvailable,
      isChecking,
      isDownloading,
      lastCheckedAt,
      error,
      checkError,
      downloadError,
      appConfig,
      check,
      applyOtaUpdate,
      currentlyRunning,
    ]
  );

  return <UpdatesContext.Provider value={value}>{children}</UpdatesContext.Provider>;
}

export function useAppUpdates() {
  const ctx = useContext(UpdatesContext);
  if (!ctx) throw new Error('useAppUpdates must be used inside <UpdatesProvider>');
  return ctx;
}
