/**
 * Phase 3A — main-process logging.
 *
 * A minimal, injectable logger. In production the electron-log module
 * writes to `%APPDATA%/Horizon Trade/logs/main.log`. Tests may pass
 * a memory sink.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  scope: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface LogSink {
  write(entry: LogEntry): void;
}

const REDACT_KEYS = [
  'password', 'token', 'apiKey', 'apiSecret', 'coinbaseKey',
  'coinbaseSecret', 'credential', 'authorization', 'cookie',
  'sessionToken', 'refreshToken', 'accessToken',
];

export function redact(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (REDACT_KEYS.some((r) => k.toLowerCase().includes(r.toLowerCase()))) {
      out[k] = '[REDACTED]';
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redact(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export class MemorySink implements LogSink {
  readonly entries: LogEntry[] = [];
  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

export class ConsoleSink implements LogSink {
  write(entry: LogEntry): void {
    const line = `[${entry.timestamp.toISOString()}] [${entry.level.toUpperCase()}] [${entry.scope}] ${entry.message}`;
    if (entry.level === 'error') console.error(line, entry.data ?? '');
    else if (entry.level === 'warn') console.warn(line, entry.data ?? '');
    else console.log(line, entry.data ?? '');
  }
}

export class Logger {
  constructor(private readonly sink: LogSink, private readonly scope: string) {}
  child(scope: string): Logger {
    return new Logger(this.sink, `${this.scope}:${scope}`);
  }
  private emit(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    this.sink.write({ timestamp: new Date(), level, scope: this.scope, message, data: redact(data) });
  }
  debug(message: string, data?: Record<string, unknown>): void { this.emit('debug', message, data); }
  info(message: string, data?: Record<string, unknown>): void { this.emit('info', message, data); }
  warn(message: string, data?: Record<string, unknown>): void { this.emit('warn', message, data); }
  error(message: string, data?: Record<string, unknown>): void { this.emit('error', message, data); }
}
