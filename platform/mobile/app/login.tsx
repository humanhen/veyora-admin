import React, { useState } from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useSession } from '../src/session';
import { ApiError, auth } from '../src/api';
import { Button, ErrorNote } from '../src/components/ui';
import { colors, radius, spacing, text } from '../src/theme';

export default function LoginScreen() {
  const { signIn } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await signIn(email.trim(), password);
    } catch (e) {
      // The API distinguishes "not activated yet" from bad credentials; that
      // difference is the whole reason a migrated customer can't get in, so
      // surface it rather than a generic failure.
      if (e instanceof ApiError && e.data?.error === 'account_pending') {
        setError('This account has not been activated yet. Tap "Activate account" below.');
      } else if (e instanceof ApiError) {
        setError(e.message);
      } else {
        setError('Could not reach Veyora. Check your connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function sendActivation() {
    if (!email.trim()) {
      setError('Enter your email address first.');
      return;
    }
    setError(null);
    try {
      await auth.requestActivationOtp(email.trim());
      setNotice('If that address is registered, an activation code is on its way.');
    } catch {
      setNotice('If that address is registered, an activation code is on its way.');
    }
  }

  async function forgot() {
    if (!email.trim()) {
      setError('Enter your email address first.');
      return;
    }
    setError(null);
    try {
      await auth.forgotPassword(email.trim());
      setNotice('If that address is registered, a reset email is on its way.');
    } catch {
      setNotice('If that address is registered, a reset email is on its way.');
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Image
            source={require('../assets/icon.png')}
            style={styles.logo}
            resizeMode="contain"
          />
          <Text style={styles.title}>Sign in</Text>
          <Text style={styles.subtitle}>Wholesale eyewear for optical retailers.</Text>

          {!!error && <ErrorNote message={error} />}
          {!!notice && (
            <View style={styles.notice}>
              <Text style={{ color: colors.accent, fontSize: 13 }}>{notice}</Text>
            </View>
          )}

          <Text style={styles.label}>Email</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="username"
            placeholder="you@business.com"
            placeholderTextColor={colors.muted}
            returnKeyType="next"
          />

          <Text style={styles.label}>Password</Text>
          <View style={styles.passwordRow}>
            <TextInput
              style={[styles.input, styles.passwordInput]}
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="password"
              placeholder="••••••••"
              placeholderTextColor={colors.muted}
              returnKeyType="go"
              onSubmitEditing={submit}
            />
            <Pressable onPress={() => setShowPassword((v) => !v)} hitSlop={8} style={styles.eye}>
              <Text style={styles.link}>{showPassword ? 'Hide' : 'Show'}</Text>
            </Pressable>
          </View>

          <Button
            title="Sign in"
            onPress={submit}
            loading={busy}
            style={{ marginTop: spacing.lg }}
          />

          <View style={styles.links}>
            <Pressable onPress={forgot} hitSlop={8}>
              <Text style={styles.link}>Forgot password</Text>
            </Pressable>
            <Pressable onPress={sendActivation} hitSlop={8}>
              <Text style={styles.link}>Activate account</Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xl, paddingTop: spacing.xl * 2, gap: spacing.sm },
  logo: { width: 64, height: 64, borderRadius: radius, alignSelf: 'center' },
  title: { ...text.title, marginTop: spacing.lg, textAlign: 'center' },
  subtitle: { ...text.small, textAlign: 'center', marginBottom: spacing.lg },
  label: { ...text.small, marginTop: spacing.md, marginBottom: spacing.xs },
  input: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius,
    paddingHorizontal: spacing.md,
    minHeight: 46,
    fontSize: 15,
    color: colors.ink,
  },
  passwordRow: { justifyContent: 'center' },
  passwordInput: { paddingRight: 64 },
  eye: { position: 'absolute', right: spacing.md },
  links: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.lg,
  },
  link: { color: colors.accent, fontSize: 14, fontWeight: '600' },
  notice: {
    backgroundColor: colors.softBlue,
    borderRadius: radius,
    padding: spacing.md,
  },
});
