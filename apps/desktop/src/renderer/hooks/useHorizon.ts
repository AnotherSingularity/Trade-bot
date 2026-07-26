import { useCallback, useEffect, useState } from 'react';
import type {
  AppVersionResponse,
  AuthOperationResponse,
  DesktopStatusResponse,
  SafeConfigResponse,
  SanitizedAuthState,
  ServiceHealth,
} from '../../shared/ipcContract';

/**
 * Phase 3A §AC — Renderer API boundary.
 *
 * All data comes from authenticated server APIs or typed desktop IPC.
 * The renderer never talks to MariaDB, Redis or the local filesystem
 * directly. This hook wraps the preload bridge; when it's absent
 * (test environments without Electron), it returns safe defaults so
 * screens still render.
 */

declare global {
  interface Window {
    horizon?: {
      getDesktopStatus(): Promise<DesktopStatusResponse>;
      readSafeConfiguration(): Promise<SafeConfigResponse>;
      getServiceHealth(): Promise<{ services: ServiceHealth[] }>;
      getApplicationVersion(): Promise<AppVersionResponse>;
      selectExportFolder(): Promise<{ folder: string | null }>;
      // Stage 2 §16 — sanitized auth surface. Every method returns
      // ONLY the sanitized state envelope (no raw tokens).
      auth?: {
        getState(): Promise<SanitizedAuthState>;
        setup(input: { username: string; password: string; passwordConfirmation: string }): Promise<AuthOperationResponse>;
        login(input: { username: string; password: string }): Promise<AuthOperationResponse>;
        logout(): Promise<AuthOperationResponse>;
        lock(): Promise<AuthOperationResponse>;
        refresh(): Promise<AuthOperationResponse>;
        changePassword(input: { currentPassword: string; newPassword: string; newPasswordConfirmation: string }): Promise<AuthOperationResponse>;
        revokeAll(): Promise<AuthOperationResponse>;
      };
    };
  }
}

export function useDesktopStatus(): { status: DesktopStatusResponse | null; loading: boolean; error: string | null } {
  const [status, setStatus] = useState<DesktopStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    if (!window.horizon) {
      setLoading(false);
      return () => {};
    }
    window.horizon.getDesktopStatus()
      .then((s) => { if (mounted) { setStatus(s); setLoading(false); } })
      .catch((e) => { if (mounted) { setError(String(e)); setLoading(false); } });
    return () => { mounted = false; };
  }, []);
  return { status, loading, error };
}

export function useSafeConfiguration(): { config: SafeConfigResponse | null; loading: boolean; error: string | null } {
  const [config, setConfig] = useState<SafeConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    if (!window.horizon) { setLoading(false); return () => {}; }
    window.horizon.readSafeConfiguration()
      .then((c) => { if (mounted) { setConfig(c); setLoading(false); } })
      .catch((e) => { if (mounted) { setError(String(e)); setLoading(false); } });
    return () => { mounted = false; };
  }, []);
  return { config, loading, error };
}

export function useServiceHealth(): { services: ServiceHealth[]; loading: boolean; error: string | null; refresh: () => void } {
  const [services, setServices] = useState<ServiceHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetch = useCallback(() => {
    if (!window.horizon) { setLoading(false); return; }
    window.horizon.getServiceHealth()
      .then((r) => { setServices(r.services); setLoading(false); })
      .catch((e) => { setError(String(e)); setLoading(false); });
  }, []);
  useEffect(() => { fetch(); }, [fetch]);
  return { services, loading, error, refresh: fetch };
}

export function useApplicationVersion(): { version: AppVersionResponse | null; loading: boolean; error: string | null } {
  const [version, setVersion] = useState<AppVersionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    if (!window.horizon) { setLoading(false); return () => {}; }
    window.horizon.getApplicationVersion()
      .then((v) => { if (mounted) { setVersion(v); setLoading(false); } })
      .catch((e) => { if (mounted) { setError(String(e)); setLoading(false); } });
    return () => { mounted = false; };
  }, []);
  return { version, loading, error };
}
