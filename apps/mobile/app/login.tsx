import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../hooks/useAuth';
import { theme } from '../theme';

export default function LoginScreen() {
  const [password, setPassword] = useState('');
  const { login, isLoggingIn, loginError } = useAuth();

  const onSubmit = async () => {
    if (!password) return;
    try {
      await login(password);
    } catch {
      // error surfaced via loginError
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.inner}
      >
        <View style={styles.brand}>
          <Text style={styles.logo}>HORIZON</Text>
          <Text style={styles.logoSub}>TRADE</Text>
        </View>

        <Text style={styles.label}>ACCESS PASSWORD</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          placeholder="••••••••"
          placeholderTextColor={theme.colors.muted}
          secureTextEntry
          autoCapitalize="none"
          onSubmitEditing={onSubmit}
          returnKeyType="go"
        />

        {loginError ? <Text style={styles.error}>{loginError}</Text> : null}

        <TouchableOpacity
          style={[styles.button, !password && styles.buttonDisabled]}
          onPress={onSubmit}
          disabled={!password || isLoggingIn}
          activeOpacity={0.8}
        >
          {isLoggingIn ? (
            <ActivityIndicator color={theme.colors.bg} />
          ) : (
            <Text style={styles.buttonText}>UNLOCK</Text>
          )}
        </TouchableOpacity>

        <Text style={styles.footer}>Horizon Holdings · Secure Single-User Access</Text>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.bg },
  inner: { flex: 1, padding: theme.spacing.xl, justifyContent: 'center' },
  brand: { alignItems: 'center', marginBottom: theme.spacing.xl * 2 },
  logo: {
    color: theme.colors.white,
    fontSize: 40,
    letterSpacing: 8,
    fontFamily: theme.fonts.monoBold,
  },
  logoSub: { color: theme.colors.green, fontSize: 18, letterSpacing: 12, fontFamily: theme.fonts.mono },
  label: {
    color: theme.colors.secondary,
    fontSize: 11,
    letterSpacing: 1.5,
    fontFamily: theme.fonts.mono,
    marginBottom: theme.spacing.sm,
  },
  input: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
    color: theme.colors.white,
    fontSize: 18,
    fontFamily: theme.fonts.mono,
  },
  error: { color: theme.colors.red, marginTop: theme.spacing.sm, fontFamily: theme.fonts.mono, fontSize: 12 },
  button: {
    backgroundColor: theme.colors.green,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
    alignItems: 'center',
    marginTop: theme.spacing.lg,
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: theme.colors.bg, fontSize: 16, letterSpacing: 2, fontFamily: theme.fonts.monoBold },
  footer: {
    color: theme.colors.muted,
    fontSize: 10,
    textAlign: 'center',
    marginTop: theme.spacing.xl,
    fontFamily: theme.fonts.mono,
  },
});
