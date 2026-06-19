import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { trpc } from '../lib/trpc';
import { clearToken, getToken, setToken } from '../lib/api';

/** Auth state + login/logout helpers backed by SecureStore. */
export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const router = useRouter();
  const loginMutation = trpc.auth.login.useMutation();

  useEffect(() => {
    getToken().then((t) => setIsAuthenticated(Boolean(t)));
  }, []);

  const login = useCallback(
    async (password: string) => {
      const res = await loginMutation.mutateAsync({ password });
      await setToken(res.token);
      setIsAuthenticated(true);
      router.replace('/');
    },
    [loginMutation, router],
  );

  const logout = useCallback(async () => {
    await clearToken();
    setIsAuthenticated(false);
    router.replace('/login');
  }, [router]);

  return {
    isAuthenticated,
    login,
    logout,
    isLoggingIn: loginMutation.isPending,
    loginError: loginMutation.error?.message ?? null,
  };
}
