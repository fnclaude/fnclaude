/**
 * `get_usage` handler (#171) — budget visibility.
 *
 * Unlike the §8 slash-injection tools, this one RETURNS structured data to
 * the model: per-model session cost + tokens, current context size, and a
 * `limits` block. The model calls it at high-token decision points (parallel
 * fan-out, large reads, deep exploration) to inform model-tier and
 * parallelism choices — see `prompts/budget.md`.
 *
 * Data source is the shared session-usage reader (`readSessionUsage`), which
 * parses the live session JSONL Claude Code appends under
 * `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`. The handler binds
 * `launchCWD` at construction (same scheme as the restart / switch handlers'
 * `livePermissionModeReader`) and takes the per-call `session_id` off the
 * wire request, exactly as `fnc_restart` does — Claude Code does not expose
 * the session id to MCP tool input directly, so the model reads
 * `$CLAUDE_CODE_SESSION_ID` via Bash and passes it verbatim.
 *
 * `limits` is `null` in v1, deliberately. The three subscription quotas
 * (5-hour, weekly all-models, weekly Sonnet-only) come from the
 * `anthropic-ratelimit-unified-*` response headers — and those headers flow
 * to claude over its own API connection, NOT through fnc's pty wrapper. fnc
 * sees the rendered terminal bytes, not the raw HTTP response, so the
 * headers are simply invisible to it today. Per the issue's null semantics,
 * `null` means "not yet observed" (not "no limit" and not "zero"); returning
 * `null` is the honest answer until a header-observation seam exists. We do
 * NOT fabricate limit values.
 *
 * The reader is injectable for tests: pass `readUsage` to feed a fixture
 * `SessionUsage` without touching a real `~/.claude`.
 */

import {
  readSessionUsage,
  type SessionUsage,
} from '../../usage/session-usage';
import type { ParentDispatchHandler } from '../parent-dispatch';
import type { WireRequest, WireResponse } from '../wire';

const SESSION_ID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Per-model breakdown as the #171 response shape: flat token categories
 * plus the computed cost. Mirrors the issue's `by_model` entry exactly
 * (`input`, `output`, `cache_read`, `cache_write`, `cost`).
 */
export interface UsageByModel {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost: number;
}

/** The `session` block of the #171 response. */
export interface UsageSession {
  cost_usd: number;
  by_model: Record<string, UsageByModel>;
}

/** The `context` block of the #171 response. */
export interface UsageContext {
  used: number | null;
  /** Model id of the latest turn, or `null` when no assistant turn yet. */
  model: string | null;
}

/**
 * The full #171 response payload. `limits` is `null` in v1 (header
 * invisibility — see the file header). `action: 'usage'` tags the wire
 * envelope so the response is self-describing on the socket.
 */
export interface UsageResponse {
  action: 'usage';
  session: UsageSession;
  limits: null;
  context: UsageContext;
}

/** Reader seam: cwd + session id → parsed usage. Defaults to the on-disk reader. */
export type SessionUsageReader = (launchCWD: string, sessionID: string) => SessionUsage;

export interface CreateGetUsageHandlerArgs {
  /** The directory fnc launched claude into — the encoded-cwd half of the JSONL path. */
  launchCWD: string;
  /** Injectable for tests; defaults to {@link readSessionUsage}. */
  readUsage?: SessionUsageReader;
}

/**
 * Build the `get_usage` handler with `launchCWD` bound. The returned
 * function plugs into `createParentDispatcher({ handlers: { get_usage, … } })`.
 */
export function createGetUsageHandler(args: CreateGetUsageHandlerArgs): ParentDispatchHandler {
  const { launchCWD } = args;
  const readUsage = args.readUsage ?? readSessionUsage;

  return async (req: WireRequest): Promise<WireResponse> => {
    const sessionID = req.session_id;
    if (typeof sessionID !== 'string' || sessionID === '') {
      return {
        action: 'error',
        error:
          'get_usage requires a session id; pass it as the get_usage session_id argument (read $CLAUDE_CODE_SESSION_ID via Bash).',
      };
    }
    if (!SESSION_ID_RE.test(sessionID)) {
      return {
        action: 'error',
        error: `session_id ${JSON.stringify(sessionID)} is not a valid UUID; expected the 8-4-4-4-12 hex form.`,
      };
    }

    const usage = readUsage(launchCWD, sessionID);
    return buildUsageResponse(usage) as unknown as WireResponse;
  };
}

/**
 * Shape a parsed {@link SessionUsage} into the #171 response. Pure — exposed
 * for unit tests that feed a fixture `SessionUsage` directly.
 */
export function buildUsageResponse(usage: SessionUsage): UsageResponse {
  const by_model: Record<string, UsageByModel> = {};
  for (const [model, m] of Object.entries(usage.perModel)) {
    by_model[model] = {
      input: m.tokens.input,
      output: m.tokens.output,
      cache_read: m.tokens.cacheRead,
      cache_write: m.tokens.cacheCreation,
      cost: m.costUsd,
    };
  }

  return {
    action: 'usage',
    session: {
      cost_usd: usage.totalCostUsd,
      by_model,
    },
    // null = "not yet observed": the anthropic-ratelimit-unified-* headers
    // never reach fnc's pty wrapper, so live limits can't be reported in v1.
    limits: null,
    context: {
      used: usage.context?.tokens ?? null,
      model: usage.context?.model ?? null,
    },
  };
}
