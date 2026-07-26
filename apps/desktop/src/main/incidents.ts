/**
 * Stage 1 §15 — Desktop incident sink.
 *
 * In-process incident list surfaced to the operator via IPC and
 * persisted to `desktop_incidents` when the server is reachable.
 * Never contains raw secrets — the Logger's redact function is
 * applied to any attached data.
 */

import { redact } from './logging';

export type IncidentSeverity = 'info' | 'warn' | 'error' | 'critical';

export interface DesktopIncident {
  id: number;
  createdAt: Date;
  severity: IncidentSeverity;
  source: string;
  code: string;
  message: string;
  data?: Record<string, unknown>;
}

export class DesktopIncidentSink {
  private nextId = 1;
  readonly items: DesktopIncident[] = [];

  record(input: Omit<DesktopIncident, 'id' | 'createdAt'>): DesktopIncident {
    const rec: DesktopIncident = {
      id: this.nextId++,
      createdAt: new Date(),
      severity: input.severity,
      source: input.source,
      code: input.code,
      message: input.message,
      data: input.data ? redact(input.data) : undefined,
    };
    this.items.push(rec);
    return rec;
  }

  recent(n: number = 20): DesktopIncident[] {
    return this.items.slice(-n).map((r) => ({ ...r }));
  }
}
