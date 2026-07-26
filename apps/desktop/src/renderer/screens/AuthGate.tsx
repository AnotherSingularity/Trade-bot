/**
 * Stage 2 §15 — Auth gate component.
 *
 * Renders one of six auth screens based on the sanitized auth phase,
 * or renders `children` when the operator is fully authenticated.
 *
 * Every screen renders ONLY what the sanitized state permits — a phase
 * plus, optionally, a username. There is no access token here, no
 * refresh token, no password hash, no bootstrap token. The auth screens
 * NEVER attempt to fetch business data — this is the entire boundary.
 *
 * Stage 2 §17: Stage 3 will bind screens to authenticated business
 * data. This stage restricts the renderer strictly to the auth flow.
 */

import { useState, type ReactNode } from 'react';
import { useAuth } from '../hooks/useAuth';
import type { AuthOperationResponse, SanitizedAuthState } from '../../shared/ipcContract';

function StatusBanner({ text }: { text: string }) {
  return (
    <div className="banner-danger" style={{
      padding: '8px 12px', margin: '8px 0',
      backgroundColor: '#7c1d1d', color: '#ffdcdc',
      borderRadius: 4, fontSize: 13,
    }}>{text}</div>
  );
}

function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: '100vh', backgroundColor: '#0f1216', color: '#e6e6e6',
    }}>
      <div style={{
        width: 420, padding: 32, borderRadius: 8,
        backgroundColor: '#1a1e26', boxShadow: '0 4px 24px rgba(0,0,0,0.6)',
      }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Horizon Trade</h1>
        <h2 style={{ margin: '8px 0 4px', fontSize: 16, fontWeight: 400, color: '#9aa4b2' }}>{title}</h2>
        {subtitle && <p style={{ margin: '0 0 16px', fontSize: 13, color: '#6f7684' }}>{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}

function Field({ label, type, value, onChange, autoFocus }: {
  label: string; type: string; value: string; onChange: (v: string) => void; autoFocus?: boolean;
}) {
  return (
    <label style={{ display: 'block', margin: '10px 0', fontSize: 13 }}>
      <div style={{ marginBottom: 4, color: '#9aa4b2' }}>{label}</div>
      <input
        type={type}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: '100%', padding: '8px 10px', borderRadius: 4,
          border: '1px solid #2a303b', backgroundColor: '#0f1216',
          color: '#e6e6e6', fontFamily: 'inherit', fontSize: 14,
        }}
      />
    </label>
  );
}

function PrimaryButton({ children, disabled, onClick }: { children: ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: '100%', padding: '10px 16px', marginTop: 12,
        borderRadius: 4, border: 'none',
        backgroundColor: disabled ? '#2a303b' : '#3b82f6',
        color: disabled ? '#6f7684' : 'white',
        fontSize: 14, fontWeight: 500, cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >{children}</button>
  );
}

function SecondaryButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%', padding: '10px 16px', marginTop: 8,
        borderRadius: 4, border: '1px solid #2a303b',
        backgroundColor: 'transparent', color: '#9aa4b2',
        fontSize: 13, cursor: 'pointer',
      }}
    >{children}</button>
  );
}

function reasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  const map: Record<string, string> = {
    password_mismatch: 'The passwords do not match.',
    password_policy_violation: 'The password does not meet the policy.',
    accounts_already_exist: 'Setup has already been completed on this installation.',
    username_taken: 'That username is already in use.',
    username_invalid: 'That username is invalid.',
    rate_limited: 'Too many attempts. Try again after the lockout expires.',
    locked: 'This account is locked. Contact the operator for recovery.',
    disabled: 'This account is disabled.',
    recovery_required: 'This account requires recovery. Use the desktop recovery CLI.',
    not_found: 'Login failed.',
    password_mismatch_login: 'Login failed.',
    already_rotated_family_revoked: 'Session was revoked (refresh reuse detected).',
    refresh_expired: 'Session refresh window expired — please sign in again.',
    absolute_expired: 'Session absolute lifetime expired — please sign in again.',
    current_password_mismatch: 'Current password is incorrect.',
    no_bridge: 'Desktop bridge unavailable. Restart the app.',
  };
  return map[reason] ?? reason;
}

function SetupScreen({ actions }: { actions: ReturnType<typeof useAuth>['actions'] }) {
  const [username, setUsername] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const r: AuthOperationResponse = await actions.setup(username, pw, pw2);
    setBusy(false);
    if (!r.ok) setReason(r.reason);
  };
  return (
    <AuthShell title="First-run setup" subtitle="Create the local operator account. This account is stored only on this machine.">
      {reason && <StatusBanner text={reasonLabel(reason) ?? reason} />}
      <Field label="Username" type="text" value={username} onChange={setUsername} autoFocus />
      <Field label="Password (min 14 characters)" type="password" value={pw} onChange={setPw} />
      <Field label="Confirm password" type="password" value={pw2} onChange={setPw2} />
      <PrimaryButton disabled={busy || !username || !pw || !pw2} onClick={submit}>
        {busy ? 'Creating…' : 'Create operator account'}
      </PrimaryButton>
    </AuthShell>
  );
}

function LoginScreen({ actions, failureReason }: { actions: ReturnType<typeof useAuth>['actions']; failureReason: string | null }) {
  const [username, setUsername] = useState('');
  const [pw, setPw] = useState('');
  const [reason, setReason] = useState<string | null>(failureReason);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const r: AuthOperationResponse = await actions.login(username, pw);
    setBusy(false);
    if (!r.ok) setReason(r.reason);
  };
  return (
    <AuthShell title="Sign in">
      {reason && <StatusBanner text={reasonLabel(reason) ?? reason} />}
      <Field label="Username" type="text" value={username} onChange={setUsername} autoFocus />
      <Field label="Password" type="password" value={pw} onChange={setPw} />
      <PrimaryButton disabled={busy || !username || !pw} onClick={submit}>
        {busy ? 'Signing in…' : 'Sign in'}
      </PrimaryButton>
    </AuthShell>
  );
}

function LockedScreen({ state, actions }: { state: SanitizedAuthState; actions: ReturnType<typeof useAuth>['actions'] }) {
  const [pw, setPw] = useState('');
  const [reason, setReason] = useState<string | null>(state.failureReason);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!state.username) return;
    setBusy(true);
    const r = await actions.login(state.username, pw);
    setBusy(false);
    if (!r.ok) setReason(r.reason);
  };
  return (
    <AuthShell title="Locked" subtitle={state.username ? `Signed in as ${state.username}` : undefined}>
      <StatusBanner text="Session locked — enter your password to resume." />
      {reason && reason !== state.failureReason && <StatusBanner text={reasonLabel(reason) ?? reason} />}
      <Field label="Password" type="password" value={pw} onChange={setPw} autoFocus />
      <PrimaryButton disabled={busy || !pw} onClick={submit}>{busy ? 'Unlocking…' : 'Unlock'}</PrimaryButton>
      <SecondaryButton onClick={() => void actions.logout()}>Sign out</SecondaryButton>
    </AuthShell>
  );
}

function SessionExpiredScreen({ actions }: { actions: ReturnType<typeof useAuth>['actions'] }) {
  return (
    <AuthShell title="Session expired" subtitle="Your session has passed its lifetime and cannot be renewed.">
      <StatusBanner text="Please sign in again." />
      <PrimaryButton onClick={() => void actions.logout()}>Return to sign-in</PrimaryButton>
    </AuthShell>
  );
}

function SessionRevokedScreen({ actions }: { actions: ReturnType<typeof useAuth>['actions'] }) {
  return (
    <AuthShell title="Session revoked" subtitle="Your session was revoked. This may indicate refresh-token reuse.">
      <StatusBanner text="For security, this session has been terminated. Please sign in again." />
      <PrimaryButton onClick={() => void actions.logout()}>Return to sign-in</PrimaryButton>
    </AuthShell>
  );
}

function PasswordChangeScreen({ actions }: { actions: ReturnType<typeof useAuth>['actions'] }) {
  const [current, setCurrent] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const r = await actions.changePassword(current, pw, pw2);
    setBusy(false);
    if (!r.ok) setReason(r.reason);
  };
  return (
    <AuthShell title="Change password" subtitle="After changing your password, every session (including this one) will be revoked.">
      {reason && <StatusBanner text={reasonLabel(reason) ?? reason} />}
      <Field label="Current password" type="password" value={current} onChange={setCurrent} autoFocus />
      <Field label="New password (min 14 characters)" type="password" value={pw} onChange={setPw} />
      <Field label="Confirm new password" type="password" value={pw2} onChange={setPw2} />
      <PrimaryButton disabled={busy || !current || !pw || !pw2} onClick={submit}>
        {busy ? 'Changing…' : 'Change password'}
      </PrimaryButton>
    </AuthShell>
  );
}

function BootstrapUnavailableScreen({ state, onRetry }: { state: SanitizedAuthState; onRetry: () => void }) {
  return (
    <AuthShell title="Waiting for server" subtitle="The Horizon Trade server has not signalled ready yet.">
      <StatusBanner text={state.failureReason ?? 'The desktop supervisor has not been able to reach the server.'} />
      <PrimaryButton onClick={onRetry}>Retry</PrimaryButton>
    </AuthShell>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { state, loading, refresh, actions } = useAuth();

  if (loading) return null;

  switch (state.phase) {
    case 'bootstrap_unavailable':
      return <BootstrapUnavailableScreen state={state} onRetry={() => void refresh()} />;
    case 'setup_required':
      return <SetupScreen actions={actions} />;
    case 'account_locked':
    case 'locked':
      return <LockedScreen state={state} actions={actions} />;
    case 'session_expired':
      return <SessionExpiredScreen actions={actions} />;
    case 'session_revoked':
      return <SessionRevokedScreen actions={actions} />;
    case 'password_change_required':
      return <PasswordChangeScreen actions={actions} />;
    case 'unauthenticated':
      return <LoginScreen actions={actions} failureReason={state.failureReason} />;
    case 'authenticated':
      return <>{children}</>;
    default:
      return <LoginScreen actions={actions} failureReason={state.failureReason} />;
  }
}
