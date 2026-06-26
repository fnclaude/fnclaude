/**
 * The file LogSink — the only sink this subsystem ships.
 *
 * Serializes each LogRecord to a single JSON line (`JSON.stringify(rec) + '\n'`,
 * i.e. JSONL) and appends it to the log file. Production append default is
 * appendFileSync; tests inject a spy. Every write is best-effort: any throw is
 * routed to onError (default: swallow) and never escapes the sink, so a failed
 * write, a vanished file, or a permission error degrades to silence rather than
 * crashing the launcher mid-session.
 *
 * File-ONLY by design: during a live session the controlling terminal is
 * claude's TUI (fnc tees PTY output to stdout), so a stdout/stderr sink would
 * corrupt claude's render. There is deliberately no console sink here.
 */

import { appendFileSync } from 'node:fs';

import type { LogRecord, LogSink } from './logger';

export interface CreateFileSinkArgs {
  path: string;
  append?: (path: string, line: string) => void;
  onError?: (err: unknown) => void;
}

export function createFileSink(args: CreateFileSinkArgs): LogSink {
  const append = args.append ?? ((path: string, line: string) => appendFileSync(path, line, 'utf8'));
  const onError = args.onError ?? (() => {});

  return (rec: LogRecord): void => {
    try {
      append(args.path, `${JSON.stringify(rec)}\n`);
    } catch (err) {
      onError(err);
    }
  };
}
