/**
 * Run root (design.di-architecture §2b, §9 PR-4): the session container plus the two
 * execve tails, which live OUTSIDE it.
 *
 * `runSession` builds the run container, resolves {@link ISession}, and runs it inside
 * an `await using` block. Only AFTER that block completes — a hard happens-before, not
 * the pre-DI teardown-vs-execve race — does it invoke a tail: the MCP-triggered handoff
 * re-exec, or the cross-cwd silent relaunch. Neither tail is ever a registered service
 * (doctrine 5). A bind failure surfaces as `fnclaude: <message>` + exit 2 with claude
 * never spawned; run-phase warnings flush on the plain-exit path only.
 */

import {
  Builder,
  standardLifetime,
  validateBuildability,
  validateScopes,
  validateUniversalAddresses,
} from '@rhombus-std/di';
import type {} from '@rhombus-std/di.extras';

import { dirname } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';

import { configuredPaths } from '../config/configured';
import { reexecSelf } from '../handoff/awaiter';
import { decideCrossCwdRelaunch } from '../launch/cross-cwd-relaunch';
import { sessionJSONLPath } from '../launch/live-permission-reader';
import { registerRunServices } from '../launch/register';
import { McpBindError } from '../mcp/listener-service';
import { detectSpawnCandidates, detectTools } from '../oobe/detect';
import { resolvePromptsDir } from '../prompts/dir';

import type { ISession, LaunchPlan, OobeContext, SessionOutcome } from '../launch/contracts';

/** An open run container: the resolved session, disposed when the scope closes. */
interface RunScope extends AsyncDisposable {
  readonly session: ISession;
}

/** Test seams for {@link runSession}: substitute the container, the tails, and the resume probe. */
export interface RunSessionDeps {
  /** Open the session scope; defaults to building the real run container. */
  openSession?: (plan: LaunchPlan, oobe: OobeContext | undefined) => RunScope | Promise<RunScope>;
  /** Replace the process image with `argv`; defaults to the real execve tail. */
  reexec?: (argv: readonly string[]) => Promise<void>;
  /** Whether claude can resume `uuid` from `cwd`; defaults to the real JSONL probe. */
  sessionExists?: (cwd: string, uuid: string) => boolean;
}

/** Build the run container, run the session, then invoke a tail or flush warnings. */
export async function runSession(
  plan: LaunchPlan,
  argv: readonly string[],
  deps: RunSessionDeps = {},
): Promise<number> {
  // The claude binary was located during planning; a missing one aborts here (after the
  // dump-plan escape), never inside a container that would have bound the socket first.
  if (!plan.claudeBin.ok) {
    process.stderr.write(`${plan.claudeBin.error}\n`);
    return 127;
  }

  const oobe = plan.isOobeLaunch ? await gatherOobeContext(plan, argv) : undefined;
  const openSession = deps.openSession ?? defaultOpenSession;
  const reexec = deps.reexec ?? ((relaunch: readonly string[]) => reexecSelf({ argv: [...relaunch] }));
  const sessionExists =
    deps.sessionExists ?? ((cwd: string, uuid: string) => existsSync(sessionJSONLPath(cwd, uuid)));

  let outcome: SessionOutcome;
  {
    await using scope = await openSession(plan, oobe);
    try {
      outcome = await scope.session.run();
    } catch (err) {
      // Bind failure: stderr + exit 2, claude never spawned. `await using` disposes on
      // this unwind — the one delta vs the pre-DI raw exit(2), proven benign by a test.
      if (err instanceof McpBindError) {
        process.stderr.write(`fnclaude: ${err.message}\n`);
        return 2;
      }
      throw err;
    }
  }
  // Container disposed HERE, provably before either tail.

  // Tail 1 — MCP-triggered handoff (restart / switch stashed argv). execve never returns.
  if (outcome.handoff !== undefined) {
    await reexec(outcome.handoff);
    return outcome.exitCode;
  }

  // Tail 2 — cross-cwd silent relaunch, reading the pre-disposal ring snapshot.
  const cross = decideCrossCwdRelaunch({
    exitCode: outcome.exitCode,
    alreadyStashed: outcome.handoff !== undefined,
    ringSnapshot: outcome.ringSnapshot,
    origArgs: argv,
    sessionExists,
  });
  if (cross.relaunch) {
    await reexec(cross.argv);
    return outcome.exitCode;
  }
  if ('reason' in cross && cross.reason === 'unresolvable') {
    process.stderr.write(unresolvableMessage(cross.cwd, cross.uuid));
  }

  // Plain exit: neither tail fired. The relaunch paths skip this flush by construction
  // (execve never returns), preserving the pre-DI deferred-warning behavior.
  flushWarnings(outcome.warnings);
  return outcome.exitCode;
}

/** Build the real run container and resolve the session; disposal tears the container down. */
async function defaultOpenSession(
  plan: LaunchPlan,
  oobe: OobeContext | undefined,
): Promise<RunScope> {
  const provider = Builder.useAddon(validateUniversalAddresses())
    .useAddon(validateBuildability())
    .useAddon(validateScopes())
    .useAddon(standardLifetime())
    .withServices((m) => registerRunServices(m, plan, oobe))
    .build();
  return {
    session: provider.resolve<ISession>(),
    [Symbol.asyncDispose]: () => provider[Symbol.asyncDispose](),
  };
}

/** Collect the frozen inputs the OOBE overlay needs, before the container chain opens. */
async function gatherOobeContext(plan: LaunchPlan, argv: readonly string[]): Promise<OobeContext> {
  const binForPrompts = process.argv[1] ?? '';
  const exeDir = binForPrompts !== '' ? dirname(realpathSync(binForPrompts)) : process.cwd();
  return {
    tools: detectTools(),
    spawnCandidates: detectSpawnCandidates(),
    configured: await configuredPaths(plan.xdg),
    packagedPromptsDir: resolvePromptsDir({ envOverride: process.env.FNC_PROMPTS_DIR, exeDir }).dir,
    applyArgv: argv.filter((a) => a !== 'install'),
  };
}

/** Write each deferred warning to stderr, one per line, adding a newline when absent. */
function flushWarnings(warnings: readonly string[]): void {
  for (const warning of warnings) {
    process.stderr.write(warning.endsWith('\n') ? warning : `${warning}\n`);
  }
}

/** The message shown when a cross-cwd resume points at a directory that no longer hosts the log. */
function unresolvableMessage(cwd: string, uuid: string): string {
  return (
    `fnclaude: cannot resume session ${uuid} — its recorded ` +
    `directory (${cwd}) no longer hosts the session log. ` +
    `This usually means the session ran in a worktree that has since been ` +
    `removed. Resume it from the directory where it was created, or start ` +
    `a fresh session.\n`
  );
}
