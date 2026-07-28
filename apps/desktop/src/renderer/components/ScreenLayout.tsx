import type { ReactNode } from 'react';

/**
 * Phase 3A §H — Screen chrome shared across every route.
 *
 * Every screen sits inside this layout — sidebar + top health bar are
 * always visible, along with the mandatory live-order-disabled state.
 */

export interface ScreenLayoutProps {
  title: string;
  subtitle?: string;
  banner?: { kind: 'safe' | 'warn' | 'danger' | 'info'; text: string };
  children: ReactNode;
}

export function ScreenLayout(props: ScreenLayoutProps) {
  return (
    <div>
      <h1>{props.title}</h1>
      {props.subtitle && <p className="subtitle">{props.subtitle}</p>}
      {props.banner && (
        <div className={`banner ${props.banner.kind}`}>{props.banner.text}</div>
      )}
      {props.children}
    </div>
  );
}

export function KVCard(props: { label: string; value: string | number | null; status?: string; field?: string }) {
  return (
    <div className="card" data-field={props.field}>
      <div className="k">{props.label}</div>
      <div className="v">
        {props.value ?? '—'}{' '}
        {props.status && <span className={`state-badge ${props.status.toLowerCase()}`}>{props.status}</span>}
      </div>
    </div>
  );
}

export function EmptyState(props: { message?: string }) {
  return <div className="empty">{props.message ?? 'No data available yet — the desktop is running in DRY_RUN.'}</div>;
}

export function LoadingState(props: { message?: string }) {
  return <div className="loading">{props.message ?? 'Loading…'}</div>;
}
