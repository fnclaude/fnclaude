// Port of src/noop.go (fnclaude/fnclaude Go reference).
//
// Ensures the user's noop dir exists and contains the up-to-date handoff
// template (a single-use bridge file written by the noop router when it
// hands off to a project session). Never touches CLAUDE.md or any other
// file in the dir — those are user territory.
//
// `defaultNoopDir` is re-exported from argParser.ts so callers can reach it
// from one canonical location; it's defined there because the parser uses
// it as the fallback when no positional path was provided.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export { defaultNoopDir } from './argParser.js';

/**
 * The embedded handoff.template.md content. Sourced verbatim from
 * src/noop_templates/handoff.template.md in the Go reference. Inlined here
 * (rather than read from disk) so the npm package ships a single binary
 * with no companion data files to lose.
 *
 * Update process: when the upstream template changes, copy the new content
 * here and the next seedNoop will detect the SHA-256 mismatch and rewrite
 * the on-disk copy.
 */
export const NOOP_HANDOFF_TEMPLATE = `<!--
============================================================================
  HANDOFF — BURN AFTER READING
============================================================================
  This file is a single-use bridge between Claude sessions.

  RECEIVING CLAUDE: your VERY FIRST action after reading this file is:
      rm <HANDOFF_PATH>
  Do this BEFORE responding to the user. The file is in tmpfs and
  would eventually clear on logout, but explicit deletion keeps the
  handoff queue accurate — leftover handoff files look like
  unhandled handoffs. Confirm deletion in your first message, then
  proceed with the work below.
============================================================================
-->

# Handoff from noop session — <ISO 8601 datetime>

## What the user asked for
<verbatim or near-verbatim version of the user's request — preserve their wording where you can>

## Context I gathered in noop
<anything relevant the receiving session needs: tool versions, decisions, links. Tight; don't pad.>

## What I did NOT do
<short list of what was correctly avoided in noop, so the receiving session knows where work starts>

## Suggested first steps for receiving session
1. <next concrete action>
2. <…>

## Open questions for the user
<only if any — otherwise omit the section>
`;

/**
 * Hex SHA-256 of the embedded template. Comparing hex strings is simpler
 * than comparing Buffers and reads cleanly in the on-disk check.
 */
const TEMPLATE_SHA = createHash('sha256').update(NOOP_HANDOFF_TEMPLATE).digest('hex');

/**
 * Ensure `noopDir` exists and contains the latest handoff template. Creates
 * the dir if missing; rewrites the template iff the on-disk SHA-256 differs
 * from the embedded SHA-256. Never touches any other file in the directory.
 *
 * Returns void on success; throws a wrapped Error on filesystem failure that
 * the caller should surface as a warning (best-effort — a noop session
 * without a freshly-seeded template can still receive the system prompt and
 * route requests, just won't have the template to follow).
 */
export async function seedNoop(noopDir: string): Promise<void> {
  try {
    await mkdir(noopDir, { recursive: true, mode: 0o755 });
  } catch (err) {
    throw new Error(`create noop dir ${noopDir}: ${(err as Error).message}`);
  }

  const path = join(noopDir, 'handoff.template.md');

  // Compare existing on-disk hash with the embedded hash; skip rewrite when
  // they match.
  try {
    const existing = await readFile(path);
    const existingSha = createHash('sha256').update(existing).digest('hex');
    if (existingSha === TEMPLATE_SHA) return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`read ${path}: ${(err as Error).message}`);
    }
    // ENOENT — fall through to write.
  }

  try {
    await writeFile(path, NOOP_HANDOFF_TEMPLATE, { mode: 0o644 });
  } catch (err) {
    throw new Error(`write ${path}: ${(err as Error).message}`);
  }
}
