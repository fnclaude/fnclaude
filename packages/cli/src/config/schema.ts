/**
 * TypeScript view of the fnc config schema.
 *
 * The SHIPPED artifact is `packages/cli/schemas/rhombus-rocks-fnclaude-config.json`
 * — hand-written, included in the npm tarball, and the file the owner mirrors
 * into SchemaStore (specs/rhombus-rocks-config.md § "fnc config shape"). It is
 * what `"$schema"` in a user's config points at, so editors get completion.
 *
 * This module re-declares it as a TS literal (`as const`) so `FromSchema` can
 * derive {@link FncConfigFile} at COMPILE TIME ONLY — `json-schema-to-ts` is a
 * devDependency and nothing here reaches runtime. A JSON import can't serve
 * that purpose: TypeScript widens JSON string literals to `string`, which
 * collapses every `enum` and `type` discriminator the derivation needs.
 *
 * The two copies are kept honest by `test/unit/config-schema.test.ts`, which
 * deep-equals this object against the shipped JSON. Edit either one and that
 * test fails until both agree.
 *
 * There is deliberately NO runtime validation anywhere (owner's call,
 * 2026-09-04): the loader degrades per field instead — a wrong-shaped field
 * contributes nothing and the rest of the file still loads.
 */

import type { FromSchema } from 'json-schema-to-ts';

export const FNC_CONFIG_SCHEMA_URL =
  'https://json.schemastore.org/rhombus-rocks-fnclaude-config.json';

export const fncConfigSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: FNC_CONFIG_SCHEMA_URL,
  title: 'rhombus.rocks fnclaude config',
  description:
    'Configuration for fnc, the fnclaude launcher. Lives at $XDG_CONFIG_HOME/rhombus.rocks/fnclaude/config.json (any of config.{json,jsonc,toml,yaml} is read). Settings shared with other rhombus.rocks tools live one level up, in $XDG_CONFIG_HOME/rhombus.rocks/config.json.',
  type: 'object',
  additionalProperties: true,
  properties: {
    $schema: {
      type: 'string',
      description: 'URL of this schema. Written by `fnc install` so editors offer completion.',
    },
    noOobe: {
      type: 'boolean',
      description:
        'When true, the first-run interview does not run. `fnc install` sets it after a successful Apply. Re-run the interview any time with `fnc install`.',
    },
    noopDir: {
      type: 'string',
      description:
        "fnc's starting directory — where `fnc` with no path opens a session. Defaults to $XDG_CONFIG_HOME/rhombus.rocks/fnclaude/noop. A leading `~` is expanded.",
    },
    auto: {
      type: 'object',
      additionalProperties: true,
      description: 'Behaviour fnc supplies because Claude Code has no persistent setting for it.',
      properties: {
        tmux: {
          type: 'string',
          enum: ['never', 'always', 'worktree'],
          description:
            'When to add `--tmux` to a launch. `never`; `always`; `worktree` only when creating a new worktree.',
        },
        handoff: {
          type: 'string',
          description:
            'How session transfers are handled: `never`, `ask`, or a number of seconds to delay as a string (Ctrl+C during the countdown cancels).',
        },
        spawnCommand: {
          type: 'string',
          description:
            "Template for opening a new terminal window when fnc spawns a session. Placeholders: {bin} fnc's own path, {dest} the project to open, {name} the session name, {summary} the handoff summary file.",
        },
      },
    },
    claude: {
      type: 'object',
      additionalProperties: true,
      description: 'Defaults applied to the `claude` process fnc launches.',
      properties: {
        defaultArgs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Flags appended to every claude launch, e.g. ["--chrome", "--brief"].',
        },
      },
    },
    exec: {
      type: 'object',
      additionalProperties: true,
      description: 'Process environment for the claude child.',
      properties: {
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Extra environment variables set on every claude launch.',
        },
      },
    },
    context: {
      type: 'object',
      additionalProperties: true,
      description: 'Context-budget notices injected into a live session as it fills up.',
      properties: {
        noticeThreshold: {
          type: 'number',
          exclusiveMinimum: 0,
          description:
            'Legacy single-threshold form: context size in tokens at which one notice fires. `noticeTiers` supersedes it.',
        },
        noticeTiers: {
          type: 'array',
          description:
            'Escalating notice ladder, ordered by threshold. An explicitly empty array disables the monitor.',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              at: {
                description:
                  'Threshold: a positive number of tokens, or an "NN%" string measured against the derived auto-compact point.',
                anyOf: [
                  { type: 'number', exclusiveMinimum: 0 },
                  { type: 'string', pattern: '^\\s*[0-9]*\\.?[0-9]+\\s*%\\s*$' },
                ],
              },
              level: {
                type: 'string',
                enum: ['consider', 'plan', 'now', 'urgent'],
                description: 'Urgency of the notice at this threshold.',
              },
            },
          },
        },
        noticeRepeat: {
          type: 'object',
          additionalProperties: true,
          description: 'Repeating notice after the last tier is passed.',
          properties: {
            every: {
              description:
                'Interval between repeats: a positive number of tokens, or an "NN%" string.',
              anyOf: [
                { type: 'number', exclusiveMinimum: 0 },
                { type: 'string', pattern: '^\\s*[0-9]*\\.?[0-9]+\\s*%\\s*$' },
              ],
            },
            level: {
              type: 'string',
              enum: ['consider', 'plan', 'now', 'urgent'],
              description: 'Urgency of the repeating notice.',
            },
          },
        },
      },
    },
  },
} as const;

/**
 * The on-disk shape, derived from the schema at compile time. Every field is
 * optional and `additionalProperties: true` throughout, so this describes what
 * a WELL-FORMED file looks like — it is not a guarantee about any real file.
 * The loader treats parsed input as `unknown` and narrows field by field.
 */
export type FncConfigFile = FromSchema<typeof fncConfigSchema>;
