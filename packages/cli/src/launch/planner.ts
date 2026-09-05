/**
 * The plan orchestrator (design.di-architecture §3).
 *
 * A thin sequence over injected phase services: it reasons about ordering and the
 * pure argv transforms in one place, delegates every I/O seam to a phase service
 * named in its constructor (so `validateBuildability` catches a missing collaborator
 * at the plan root's `build()`), and emits a deep-frozen, ref-free {@link LaunchPlan}.
 */

import { realpathSync } from 'node:fs';

import { parseArgs } from '../argv/parse';
import { expandAliases } from '../argv/expand';
import { expandShortFlags } from '../argv/short-flags';
import { findPromptSentinel, insertFlagsBeforeSentinel, promptBody } from '../argv/sentinel';
import { defaultNoopDir } from '../config/paths';
import { injectMcpConfig } from '../mcp/inject-config';
import { isInstallSubcommand } from '../install/subcommand';
import { buildWizardArgs, WIZARD_SESSION_NAME } from '../install/subcommand';
import { shouldAutoName } from '../name/auto-name';
import { expandTilde } from '../path/resolve';
import { injectFragments } from '../prompts/load';
import { isInteractiveSession } from '../prompts/select';
import { shouldInjectTmux } from '../worktree/auto-tmux';

import type { FnConfig } from '../config/load';
import {
  LaunchAbort,
  deepFreeze,
  type IAutoNamer,
  type IClaudeLocator,
  type ICwdResolver,
  type IEnvComposer,
  type IFragmentLoader,
  type INoopSeeder,
  type IPlanner,
  type ISessionIdMinter,
  type ISocketPathComputer,
  type IWarningBuffer,
  type IWorktreeIntercept,
  type LaunchInputs,
  type LaunchPlan,
} from './contracts';

export class Planner implements IPlanner {
  readonly #inputs: LaunchInputs;
  readonly #config: FnConfig;
  readonly #warnings: IWarningBuffer;
  readonly #cwdResolver: ICwdResolver;
  readonly #worktreeIntercept: IWorktreeIntercept;
  readonly #autoNamer: IAutoNamer;
  readonly #fragmentLoader: IFragmentLoader;
  readonly #sessionIdMinter: ISessionIdMinter;
  readonly #envComposer: IEnvComposer;
  readonly #socketPathComputer: ISocketPathComputer;
  readonly #claudeLocator: IClaudeLocator;
  readonly #noopSeeder: INoopSeeder;

  constructor(
    inputs: LaunchInputs,
    config: FnConfig,
    warnings: IWarningBuffer,
    cwdResolver: ICwdResolver,
    worktreeIntercept: IWorktreeIntercept,
    autoNamer: IAutoNamer,
    fragmentLoader: IFragmentLoader,
    sessionIdMinter: ISessionIdMinter,
    envComposer: IEnvComposer,
    socketPathComputer: ISocketPathComputer,
    claudeLocator: IClaudeLocator,
    noopSeeder: INoopSeeder,
  ) {
    this.#inputs = inputs;
    this.#config = config;
    this.#warnings = warnings;
    this.#cwdResolver = cwdResolver;
    this.#worktreeIntercept = worktreeIntercept;
    this.#autoNamer = autoNamer;
    this.#fragmentLoader = fragmentLoader;
    this.#sessionIdMinter = sessionIdMinter;
    this.#envComposer = envComposer;
    this.#socketPathComputer = socketPathComputer;
    this.#claudeLocator = claudeLocator;
    this.#noopSeeder = noopSeeder;
  }

  async plan(): Promise<LaunchPlan> {
    const inputs = this.#inputs;
    const config = this.#config;

    const parsed = parseArgs(inputs.argv);
    if (!parsed.ok) throw new LaunchAbort(parsed.error, 2);

    const noopDirPath =
      config.noopDir !== undefined && config.noopDir !== ''
        ? expandTilde(config.noopDir, inputs.home)
        : defaultNoopDir(inputs.xdg);

    // A bare `fnc install` wizard launch resolves nothing — it runs in the shell
    // cwd, and ref resolution is skipped so a directory that shares a repo's name
    // never starts a clone.
    const isOobeLaunch = isInstallSubcommand(inputs.argv);

    let cwd: string;
    let usedNoopFallback = false;
    let workspaceFromRef = '';
    if (isOobeLaunch) {
      cwd = inputs.shellCwd;
    } else {
      const resolved = await this.#cwdResolver.resolve({
        input: parsed.firstPath,
        shellCwd: inputs.shellCwd,
        home: inputs.home,
        noopDir: noopDirPath,
        onProgress: (line) => process.stderr.write(`${line}\n`),
      });
      if (resolved.kind === 'error') throw new LaunchAbort(`fnclaude: ${resolved.error}`, 2);
      cwd = resolved.launchCwd;
      usedNoopFallback = resolved.usedNoopFallback;
      workspaceFromRef = resolved.workspace;
      if (usedNoopFallback) {
        await this.#noopSeeder.seed({
          noopDir: cwd,
          env: inputs.env,
          binPath: inputs.binPath,
          shellCwd: inputs.shellCwd,
        });
      }
    }

    // Worktree intercept: `-w <name>` (or a `+workspace` suffix off a repo ref)
    // can swap cwd to an existing worktree and pushes `--worktree`/`--name`.
    const effectiveWorktreeSet = parsed.worktreeSet || workspaceFromRef !== '';
    const effectiveWorktreeArg = parsed.worktreeSet ? parsed.worktreeArg : workspaceFromRef;
    const intercept = this.#worktreeIntercept.apply({
      worktreeSet: effectiveWorktreeSet,
      worktreeArg: effectiveWorktreeArg,
      launchCwd: cwd,
      passthrough: parsed.passthrough,
    });
    for (const w of intercept.warnings) this.#warnings.add(w);
    cwd = intercept.launchCwd;
    const parsedWithIntercept = { ...parsed, passthrough: intercept.passthrough };

    // Ultracode rides as the `/effort ultracode` initial prompt, so a user prompt
    // (if any) is captured here to submit as a follow-up after claude is ready.
    const isUltracode = parsedWithIntercept.effort === 'ultracode';
    const ultracodeSeedPrompt = isUltracode
      ? promptBody(parsedWithIntercept.passthrough).join(' ').trim()
      : '';

    const withAliases = expandAliases(parsedWithIntercept);
    const shortExpanded = expandShortFlags(withAliases);
    if (!shortExpanded.ok) throw new LaunchAbort(shortExpanded.error, 2);
    let claudeArgs = shortExpanded.tokens;

    if (
      shouldInjectTmux({
        configAutoTmux: config.autoTmux,
        worktreeSet: parsed.worktreeSet,
        worktreeMatched: intercept.worktreeMatched,
        noTmux: parsed.noTmux,
        passthrough: claudeArgs,
      })
    ) {
      claudeArgs = insertFlagsBeforeSentinel(claudeArgs, '--tmux');
    }

    if (inputs.env.FNC_INTERNAL_DISABLE_AUTONAME !== '1' && shouldAutoName(parsedWithIntercept)) {
      const body = promptBody(parsedWithIntercept.passthrough).join(' ').trim();
      const name = await this.#autoNamer.generate(body, inputs.env);
      claudeArgs = insertFlagsBeforeSentinel(claudeArgs, '--name', name);
    }

    const ownSessionPlan =
      inputs.env.FNC_INTERNAL_DISABLE_SESSION_ID === '1'
        ? { sessionId: null, inject: [] as readonly string[] }
        : this.#sessionIdMinter.plan(claudeArgs);
    if (ownSessionPlan.inject.length === 2) {
      claudeArgs = insertFlagsBeforeSentinel(
        claudeArgs,
        ownSessionPlan.inject[0]!,
        ownSessionPlan.inject[1]!,
      );
    }
    const ownSessionId = ownSessionPlan.sessionId;

    const frag = this.#fragmentLoader.load({
      usedNoopFallback,
      claudeArgs,
      oobe: isOobeLaunch,
      xdg: inputs.xdg,
      env: inputs.env,
      binPath: inputs.binPath,
      shellCwd: inputs.shellCwd,
    });
    for (const w of frag.warnings) this.#warnings.add(w);
    if (frag.content !== null) claudeArgs = injectFragments(claudeArgs, frag.content);

    if (isOobeLaunch) {
      claudeArgs = insertFlagsBeforeSentinel(
        claudeArgs,
        ...buildWizardArgs('').filter((t) => t !== '--append-system-prompt' && t !== ''),
        '--name',
        WIZARD_SESSION_NAME,
      );
    }

    if (config.claudeDefaultArgs !== undefined && config.claudeDefaultArgs.length > 0) {
      claudeArgs = insertFlagsBeforeSentinel(claudeArgs, ...config.claudeDefaultArgs);
    }

    if (isUltracode) {
      const sentIdx = findPromptSentinel(claudeArgs);
      const head = sentIdx < 0 ? claudeArgs : claudeArgs.slice(0, sentIdx);
      claudeArgs = [...head, '--', '/effort ultracode'];
    }

    let socketPath: string | undefined;
    if (inputs.platform !== 'win32') {
      socketPath = this.#socketPathComputer.compute({
        env: inputs.env,
        pid: inputs.pid,
        platform: inputs.platform,
      });
    }

    const childEnv = this.#envComposer.compose({
      processEnv: inputs.env,
      execEnv: config.execEnv,
      handoff: config.autoHandoff,
      socket: socketPath,
    });
    if (isOobeLaunch) childEnv.FNC_OOBE = '1';

    if (socketPath !== undefined) {
      const fncBin = inputs.binPath !== '' ? realpathSync(inputs.binPath) : '';
      claudeArgs = injectMcpConfig({
        claudeArgs,
        bunExec: inputs.execPath,
        fncBin,
        noop: usedNoopFallback,
        interactive: isInteractiveSession(claudeArgs),
      });
    }

    // Locate claude, but let a missing binary abort in the run root (after the
    // dump-plan escape) — never here, or the dump would need claude on PATH.
    const claudeBin = this.#claudeLocator.locate(inputs.env.PATH ?? '');

    const useTerminal =
      inputs.platform !== 'win32' && inputs.stdinIsTTY === true && inputs.stdoutIsTTY === true;

    const plan: LaunchPlan = {
      launchCWD: cwd,
      claudeArgv: claudeArgs,
      usedNoopFallback,
      env: childEnv,
      config,
      xdg: inputs.xdg,
      warnings: this.#warnings.drain(),
      useTerminal,
      mcpEnabled: socketPath !== undefined,
      ...(socketPath !== undefined ? { socketPath } : {}),
      sessionID: ownSessionId,
      isUltracode,
      ultracodeSeedPrompt,
      isOobeLaunch,
      claudeBin,
      origArgs: inputs.argv,
    };
    return deepFreeze(plan);
  }
}
