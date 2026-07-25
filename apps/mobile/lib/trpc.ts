import { createTRPCReact } from '@trpc/react-query';
import { httpBatchLink, TRPCClientError } from '@trpc/client';
import type { AppRouter } from '../../server/src/routers';
import { API_URL, clearToken, getToken } from './api';

/**
 * Type-safe tRPC client. The AppRouter type is imported directly from the server
 * source so the mobile app's API calls are fully checked against the backend.
 *
 * On any UNAUTHORIZED response (JWT expired or invalid), the client wipes the
 * stored token so the next mounted screen sees `authenticated=false` and the
 * tabs layout redirects to /login. This is Phase 0's auto-reauth requirement.
 */
export const trpc = createTRPCReact<AppRouter>();

type AuthListener = () => void;
const authListeners = new Set<AuthListener>();

export function subscribeToUnauthorized(fn: AuthListener): () => void {
  authListeners.add(fn);
  return () => authListeners.delete(fn);
}

async function handleUnauthorized() {
  await clearToken();
  for (const l of authListeners) {
    try {
      l();
    } catch {
      // ignore listener errors
    }
  }
}

export function createTrpcClient() {
  return trpc.createClient({
    links: [
      httpBatchLink({
        url: `${API_URL}/trpc`,
        async headers() {
          const token = await getToken();
          return token ? { authorization: `Bearer ${token}` } : {};
        },
        async fetch(url, opts) {
          const res = await fetch(url, opts);
          if (res.status === 401 || res.status === 403) {
            void handleUnauthorized();
          }
          return res;
        },
      }),
    ],
  });
}

// Re-export TRPCClientError for callers that want to differentiate error shapes.
export { TRPCClientError };
