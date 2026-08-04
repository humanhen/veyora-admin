import React, { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { View } from 'react-native';

import { SessionProvider, useSession } from '../src/session';
import { UpdatesProvider } from '../src/updates';
import { UpdateGate } from '../src/components/UpdateSurfaces';
import { Loading } from '../src/components/ui';
import { colors } from '../src/theme';

/** Keeps the URL in step with auth state: signed-out users are pushed to
    /login, and a signed-in user who lands back on /login is bounced home. */
function AuthRouter() {
  const { user, loading } = useSession();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    const onLoginScreen = segments[0] === 'login';
    if (!user && !onLoginScreen) router.replace('/login');
    else if (user && onLoginScreen) router.replace('/');
  }, [user, loading, segments, router]);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <Loading />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="login" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen
        name="product/[id]"
        options={{ headerShown: true, title: '', headerBackTitle: 'Back' }}
      />
      <Stack.Screen
        name="order/[id]"
        options={{ headerShown: true, title: 'Order', headerBackTitle: 'Back' }}
      />
      <Stack.Screen
        name="settings/updates"
        options={{ headerShown: true, title: 'App version', headerBackTitle: 'Back' }}
      />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        {/* Outside the session provider's gate on purpose: the version check
            has to run and can block the app even when nobody is signed in. */}
        <UpdatesProvider>
          <StatusBar style="dark" />
          <UpdateGate>
            <AuthRouter />
          </UpdateGate>
        </UpdatesProvider>
      </SessionProvider>
    </SafeAreaProvider>
  );
}
