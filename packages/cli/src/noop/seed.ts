/**
 * Seed `handoff.template.md` into the noop dir on first noop-fallback
 * launches (design.md §19).
 *
 * The function is a strict guard:
 *   - if `<noopDir>/handoff.template.md` already exists → no-op
 *   - if `templateSourcePath` doesn't exist on disk → no-op (graceful
 *     degradation; the launch must not fail because the embedded template
 *     wasn't shipped)
 *   - otherwise copy source → dest, creating the noop dir if missing
 *
 * NB: only `handoff.template.md` is seeded. `CLAUDE.md` and every other
 * file in the noop dir is user-owned and fnclaude never touches them.
 * That's the README divergence the rewrite caller was warned about.
 *
 * Mirrors Go canonical's `seedNoop` (src/noop.go:1–58) loosely — the Go
 * version uses SHA-256 to detect template drift; the rewrite goes with
 * "missing only" semantics, which is simpler and matches what users
 * actually want (don't clobber my hand-edited template on every launch).
 */

import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface SeedNoopDirArgs {
  noopDir: string;
  templateSourcePath: string | null;
}

export interface SeedNoopDirResult {
  ok: boolean;
  copied: boolean;
  reason?: string;
}

const TEMPLATE_FILENAME = 'handoff.template.md';

export async function seedNoopDir(args: SeedNoopDirArgs): Promise<SeedNoopDirResult> {
  if (args.templateSourcePath === null || args.templateSourcePath === '') {
    return { ok: true, copied: false, reason: 'no source template' };
  }
  if (!existsSync(args.templateSourcePath)) {
    return { ok: true, copied: false, reason: 'no source template' };
  }

  const dest = join(args.noopDir, TEMPLATE_FILENAME);
  if (existsSync(dest)) {
    return { ok: true, copied: false, reason: 'already exists' };
  }

  try {
    await mkdir(args.noopDir, { recursive: true });
    await copyFile(args.templateSourcePath, dest);
    return { ok: true, copied: true };
  } catch (err) {
    return {
      ok: false,
      copied: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
