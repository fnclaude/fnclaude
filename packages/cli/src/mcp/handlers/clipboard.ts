/**
 * §8.4 — `fnc_copy_to_clipboard` handler.
 *
 * Spec (design.mcp.md §4.4):
 *   - Required arg: `text: string`
 *   - Returns `{ action: 'done', clipboard_ok: boolean }`
 *   - NEVER errors — clipboard absence flows through the boolean flag,
 *     not an error response. Same shape on every failure mode: no
 *     backend on PATH, backend exits non-zero, spawn throws, text arg
 *     is missing or wrong type.
 *
 * Wave 1 (this PR) ships the pure module only. §7.7's parent
 * dispatcher will route `op: 'copy_to_clipboard'` to this handler in
 * Wave 2.
 */

import type { WireRequest, WireResponse } from '../wire.ts';
import {
  defaultSpawn,
  defaultWhich,
  detectBackend,
  runBackend,
  type SpawnFn,
  type WhichFn,
} from './clipboard-backends.ts';

export interface HandleCopyToClipboardDeps {
  which?: WhichFn;
  spawn?: SpawnFn;
}

/**
 * Process a `copy_to_clipboard` request. Always resolves to a `done`
 * response; the `clipboard_ok` flag carries the actual outcome.
 *
 * Deps are injected for tests; production callers omit them and get the
 * Bun.which / Bun.spawn defaults.
 */
export async function handleCopyToClipboard(
  req: WireRequest,
  deps: HandleCopyToClipboardDeps = {},
): Promise<WireResponse> {
  const which = deps.which ?? defaultWhich;
  const spawn = deps.spawn ?? defaultSpawn;

  const text = req.text;
  if (typeof text !== 'string') {
    return done(false);
  }

  const backend = detectBackend({ which });
  if (backend === null) {
    return done(false);
  }

  const ok = await runBackend({ backend, text, spawn });
  return done(ok);
}

function done(clipboardOk: boolean): WireResponse {
  return { action: 'done', clipboard_ok: clipboardOk };
}
