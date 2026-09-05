/**
 * Version reader (design.di-architecture §4): the single home for the package
 * version, consolidating the two per-call-site caches the pre-DI code carried.
 */

import { readFileSync } from 'node:fs';

/** Reads the running package's declared version. */
export interface IVersionReader {
  /** The `version` from `package.json`, or `0.0.0-dev` when it cannot be read. */
  read(): string;
}

/** Build a version reader that reads `package.json` once and caches the result. */
export function createVersionReader(): IVersionReader {
  let cached: string | null = null;
  return {
    read(): string {
      if (cached !== null) {
        return cached;
      }
      try {
        const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
        const parsed = JSON.parse(raw) as { version?: unknown };
        cached = typeof parsed.version === 'string' ? parsed.version : '0.0.0-dev';
      } catch {
        cached = '0.0.0-dev';
      }
      return cached;
    },
  };
}
