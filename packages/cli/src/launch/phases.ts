/**
 * Plan-phase service implementations (design.di-architecture §4).
 *
 * Each factory wraps an unchanged leaf behind a phase contract: sugar-free, deps
 * injected as constructor/closure arguments, callable directly in a unit test with
 * fakes. The plan root's registration file (`register.ts`) files these with the
 * engine; the {@link import('./planner').Planner} orchestrates them.
 */

import { mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';

import { findClaude } from './find-claude';
import { composeEnv } from './compose-env';
import { computeSocketPath } from '../mcp/socket-path';
import { resolveInput } from '../repo/resolve-input';
import { planOwnSession } from '../usage/own-session';
import { applyWorktreeIntercept } from '../worktree/intercept';
import { listWorktrees } from '../worktree/git-list';
import { seedNoopDir } from '../noop/seed';
import { resolveTemplateSourcePath } from '../noop/template-source';
import { resolvePromptsDir } from '../prompts/dir';
import { loadFragments } from '../prompts/load';
import { selectFragments } from '../prompts/select';
import { promptOverridesDir } from '../config/paths';
import { autoName } from '../name/auto-name';
import { AUTO_NAME_MODEL, AUTO_NAME_SYSTEM_PROMPT } from '../name/llm-prompt';
import { sanitizeForPath } from '../name/sanitize';
import { sdkLlmCall } from '../name/sdk-llm';
import { randomUUID } from 'node:crypto';

import type {
  IAutoNamer,
  IClaudeLocator,
  ICwdResolver,
  IEnvComposer,
  IFngitRunner,
  IFragmentLoader,
  INoopSeeder,
  ISessionIdMinter,
  ISocketPathComputer,
  IWorktreeIntercept,
  IWorktreeLister,
} from './contracts';

/** Resolve the exe directory from the bin path, realpathed so symlinked installs resolve. */
function exeDirOf(binPath: string, shellCwd: string): string {
  return binPath !== '' ? dirname(realpathSync(binPath)) : shellCwd;
}

/** The cwd resolver, adapting the injected object seam to the leaf's function-shaped `fngit`. */
export function createCwdResolver(fngit: IFngitRunner | undefined): ICwdResolver {
  const runner = fngit === undefined ? null : (args: readonly string[]) => fngit.run(args);
  return {
    resolve: (args) =>
      resolveInput({
        input: args.input,
        shellCwd: args.shellCwd,
        home: args.home,
        noopDir: args.noopDir,
        fngit: runner,
        ...(args.onProgress !== undefined ? { onProgress: args.onProgress } : {}),
      }),
  };
}

/** The worktree lister, wrapping `git worktree list --porcelain`. */
export function createWorktreeLister(): IWorktreeLister {
  return { list: (cwd) => listWorktrees(cwd) };
}

/** The worktree intercept, driven by the injected lister. */
export function createWorktreeIntercept(lister: IWorktreeLister): IWorktreeIntercept {
  return {
    apply: (args) =>
      applyWorktreeIntercept({
        worktreeSet: args.worktreeSet,
        worktreeArg: args.worktreeArg,
        launchCwd: args.launchCwd,
        passthrough: args.passthrough,
        listWorktrees: (cwd) => lister.list(cwd),
      }),
  };
}

/** The auto-namer: SDK fast-path when `ANTHROPIC_API_KEY` is set, else a `claude -p` subprocess. */
export function createAutoNamer(): IAutoNamer {
  return {
    generate: async (promptBody, env) => {
      const claudePLlmCall = async (prompt: string): Promise<string> => {
        const proc = Bun.spawn(
          [
            'claude',
            '-p',
            '--model',
            AUTO_NAME_MODEL,
            `${AUTO_NAME_SYSTEM_PROMPT}\n\nUser request: ${prompt}`,
          ],
          { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        );
        const out = await new Response(proc.stdout).text();
        const exit = await proc.exited;
        if (exit !== 0) throw new Error(`claude -p exited ${exit}`);
        return out;
      };
      const llmCall = env.ANTHROPIC_API_KEY !== undefined ? sdkLlmCall : claudePLlmCall;
      const generated = await autoName({ prompt: promptBody, llmCall, timeoutMs: 15_000 });
      const san = sanitizeForPath(generated);
      return san.kind === 'invalid' ? generated : san.value;
    },
  };
}

/** The fragment loader: selects fragments, resolves the prompts dir, and loads their content. */
export function createFragmentLoader(): IFragmentLoader {
  return {
    load: (args) => {
      const names = selectFragments({
        usedNoopFallback: args.usedNoopFallback,
        passthrough: args.claudeArgs,
        oobe: args.oobe,
      });
      if (names.length === 0) return { content: null, warnings: [] };
      const exeDir = exeDirOf(args.binPath, args.shellCwd);
      const promptsDir = resolvePromptsDir({
        envOverride: args.env.FNC_PROMPTS_DIR,
        exeDir,
      });
      if (promptsDir.dir === null) {
        return { content: null, warnings: promptsDir.warning !== undefined ? [promptsDir.warning] : [] };
      }
      const loaded = loadFragments(names, promptsDir.dir, promptOverridesDir(args.xdg));
      return { content: loaded.content, warnings: loaded.warnings };
    },
  };
}

/** The session-id minter, wrapping the own-session decision table with a fresh-UUID source. */
export function createSessionIdMinter(): ISessionIdMinter {
  return { plan: (claudeArgs) => planOwnSession(claudeArgs, () => randomUUID()) };
}

/** The env composer, wrapping the child-env composition. */
export function createEnvComposer(): IEnvComposer {
  return {
    compose: (args) =>
      composeEnv({
        processEnv: args.processEnv,
        execEnv: args.execEnv,
        handoff: args.handoff,
        socket: args.socket,
      }),
  };
}

/** The socket-path computer, wrapping the runtime-base formula. */
export function createSocketPathComputer(): ISocketPathComputer {
  return {
    compute: (args) => computeSocketPath({ env: args.env, pid: args.pid, platform: args.platform }),
  };
}

/** The claude locator, wrapping the PATH walk. */
export function createClaudeLocator(): IClaudeLocator {
  return { locate: (pathEnv) => findClaude({ pathEnv }) };
}

/** The noop seeder: create the fallback directory and copy the handoff template, best-effort. */
export function createNoopSeeder(): INoopSeeder {
  return {
    seed: async (args) => {
      await mkdir(args.noopDir, { recursive: true });
      const exeDir = exeDirOf(args.binPath, args.shellCwd);
      const tmplSource = resolveTemplateSourcePath({
        envOverride: args.env.FNC_NOOP_TEMPLATE_PATH,
        exeDir,
      });
      await seedNoopDir({ noopDir: args.noopDir, templateSourcePath: tmplSource.path });
    },
  };
}
