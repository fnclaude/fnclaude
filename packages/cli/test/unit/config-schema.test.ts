/**
 * The shipped JSON schema and the TS literal it is mirrored by must stay
 * identical.
 *
 * `schemas/rhombus-rocks-fnclaude-config.json` is the artifact: it ships in
 * the npm tarball, it is what a config's `"$schema"` URL resolves to once the
 * owner mirrors it into SchemaStore, and it is what gives editors completion.
 * `src/config/schema.ts` re-declares it `as const` purely so `FromSchema` can
 * derive the TS type at compile time — a JSON import can't, because TypeScript
 * widens JSON string literals to `string`.
 *
 * Two copies means drift, and drift here is silent in both directions: a key
 * added only to the TS copy never reaches an editor, and a key added only to
 * the JSON never reaches the type. This test is the mechanism that makes that
 * impossible — it fails until both agree.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { FNC_CONFIG_SCHEMA_URL, fncConfigSchema } from '../../src/config/schema';

const CLI_ROOT = resolve(__dirname, '..', '..');
const SCHEMA_PATH = resolve(CLI_ROOT, 'schemas', 'rhombus-rocks-fnclaude-config.json');

const shipped = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>;

describe('the shipped schema and the TS literal agree', () => {
  test('deep-equal, key for key', () => {
    expect(shipped).toEqual(JSON.parse(JSON.stringify(fncConfigSchema)));
  });

  test('the $id is the SchemaStore URL the writer stamps into config files', () => {
    expect(shipped.$id).toBe(FNC_CONFIG_SCHEMA_URL);
    expect(FNC_CONFIG_SCHEMA_URL).toBe(
      'https://json.schemastore.org/rhombus-rocks-fnclaude-config.json',
    );
  });
});

describe('the schema covers every field the loader reads', () => {
  const props = (shipped.properties ?? {}) as Record<string, Record<string, unknown>>;

  test('top-level keys', () => {
    expect(Object.keys(props).sort()).toEqual(
      ['$schema', 'auto', 'claude', 'context', 'exec', 'noOobe', 'noopDir'].sort(),
    );
  });

  test('auto carries exactly tmux / handoff / spawnCommand', () => {
    const auto = props.auto?.properties as Record<string, unknown>;
    expect(Object.keys(auto).sort()).toEqual(['handoff', 'spawnCommand', 'tmux']);
  });

  test('auto.tmux enumerates all three settings, including `always`', () => {
    const tmux = (props.auto?.properties as Record<string, Record<string, unknown>>).tmux;
    expect(tmux.enum).toEqual(['never', 'always', 'worktree']);
  });

  test('context uses the camelCase names, not the old TOML snake_case', () => {
    const context = props.context?.properties as Record<string, unknown>;
    expect(Object.keys(context).sort()).toEqual([
      'noticeRepeat',
      'noticeThreshold',
      'noticeTiers',
    ]);
  });

  test('additionalProperties stays open — an unknown key is not an error', () => {
    // There is no runtime validation, so this is about editors: a closed
    // schema would show a red squiggle on a key fnc simply ignores.
    expect(shipped.additionalProperties).toBe(true);
  });
});
