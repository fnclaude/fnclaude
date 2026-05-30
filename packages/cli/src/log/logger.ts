/**
 * Structured logger core for the launcher's file-only logging subsystem.
 *
 * A Logger turns `logger.info('ev', { …fields })` calls into LogRecords and
 * hands them to an injected LogSink (file-sink.ts in production). Pure with
 * respect to fs/time/process — `now`/`pid`/`ppid` are injectable seams with
 * production defaults, so tests assert exact record shapes deterministically.
 *
 * Level gating: every level has a numeric rank; a call at rank >= the
 * configured level's rank is emitted, anything below is dropped. So a logger
 * at `info` keeps info/warn/error and drops debug.
 *
 * NOOP_LOGGER is the disabled-logging fallback — all methods no-op. init.ts
 * returns it whenever logging can't or shouldn't run (silent level, mkdir
 * failure). parseLevel resolves a raw string (env var or config value) to a
 * level, the `silent` sentinel, or undefined (unrecognized → fall through to
 * the next precedence source).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogRecord {
  t: number;
  pid: number;
  ppid: number;
  lvl: LogLevel;
  ev: string;
  [k: string]: unknown;
}

export type LogSink = (rec: LogRecord) => void;

export interface Logger {
  debug(ev: string, fields?: Record<string, unknown>): void;
  info(ev: string, fields?: Record<string, unknown>): void;
  warn(ev: string, fields?: Record<string, unknown>): void;
  error(ev: string, fields?: Record<string, unknown>): void;
}

export interface CreateLoggerArgs {
  sink: LogSink;
  level: LogLevel;
  now?: () => number;
  pid?: number;
  ppid?: number;
  base?: Record<string, unknown>;
}

export function createLogger(args: CreateLoggerArgs): Logger {
  const now = args.now ?? Date.now;
  const pid = args.pid ?? process.pid;
  const ppid = args.ppid ?? process.ppid;
  const base = args.base ?? {};
  const threshold = RANK[args.level];

  const emit = (lvl: LogLevel, ev: string, fields?: Record<string, unknown>): void => {
    if (RANK[lvl] < threshold) return;
    const rec: LogRecord = {
      t: now(),
      pid,
      ppid,
      lvl,
      ev,
      ...base,
      ...(fields ?? {}),
    };
    args.sink(rec);
  };

  return {
    debug: (ev, fields) => emit('debug', ev, fields),
    info: (ev, fields) => emit('info', ev, fields),
    warn: (ev, fields) => emit('warn', ev, fields),
    error: (ev, fields) => emit('error', ev, fields),
  };
}

export const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const SILENT_ALIASES = new Set(['silent', 'off', 'none']);

export function parseLevel(raw: string | undefined): LogLevel | 'silent' | undefined {
  if (raw === undefined) return undefined;
  const norm = raw.trim().toLowerCase();
  if (norm === '') return undefined;
  if (SILENT_ALIASES.has(norm)) return 'silent';
  if (norm === 'debug' || norm === 'info' || norm === 'warn' || norm === 'error') {
    return norm;
  }
  return undefined;
}
