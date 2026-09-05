/**
 * Plan-root registrations (design.di-architecture §4).
 *
 * The one sugar-bearing plan-side file: it files the phase services and the
 * {@link Planner} with the engine, taking typed dependency parameters and calling
 * the unchanged leaf factories. fngit is registered only when it is on PATH, so a
 * consumer depending on `IFngitRunner | undefined` falls to the real-paths-only
 * branch when it is absent (union self-supply).
 */

import type { Manifest, StandardLifetime } from '@rhombus-std/di.core';
import type {} from '@rhombus-std/di.extras';

import { realpathSync } from 'node:fs';

import { NodeFileSystem } from '../ports/node-fs';
import { NodeSpawner } from '../ports/node-spawner';
import { NodeTerminalHost } from '../ports/node-terminal-host';
import { defaultWhich } from '../ports/node-which';
import { findFngit, makeFngitRunner } from '../repo/fngit';
import { createHandoffDetector } from '../handoff/handoff-detector';
import { createHandoffTrigger } from '../handoff/trigger';
import { initLogging } from '../log/init';
import { Dispatcher } from '../mcp/dispatcher';
import { createGetUsageHandler } from '../mcp/handlers/get-usage';
import { createPtyWriterHolder } from '../mcp/handlers/inject-slash';
import {
  createOobeAnswerHandler,
  createOobeNextHandler,
  createOobeReaskHandler,
  type OobeHandlerArgs,
} from '../mcp/handlers/oobe';
import { createRestartHandler } from '../mcp/handlers/restart';
import { createControlSeamHolder } from '../mcp/handlers/send-control';
import {
  createRequestCompactHandler,
  createRunSlashCommandHandler,
  createSetEffortHandler,
  createSetModelHandler,
} from '../mcp/handlers/slash-tools';
import { createSpawnHandler } from '../mcp/handlers/spawn';
import { createSwitchHandler } from '../mcp/handlers/switch';
import { handleCopyToClipboard } from '../mcp/handlers/clipboard';
import { McpListenerService } from '../mcp/listener-service';
import { buildApplyPlan, describeApplyPlan } from '../oobe/apply';
import { OobeState } from '../oobe/state';
import { ContextMonitorService } from '../usage/context-monitor-service';
import { Planner } from './planner';
import {
  createAutoNamer,
  createClaudeLocator,
  createCwdResolver,
  createEnvComposer,
  createFragmentLoader,
  createNoopSeeder,
  createSessionIdMinter,
  createSocketPathComputer,
  createWorktreeIntercept,
  createWorktreeLister,
} from './phases';
import { readLivePermissionMode } from './live-permission-reader';
import { createPlanWarnings } from './plan-warnings';
import { RingBuffer } from './ring-buffer';
import { Session } from './session';

import type { FnConfig } from '../config/load';
import type { XdgEnv } from '../config/paths';
import type { IFileSystem, IProcessSpawner, IWhich } from '../ports/contracts';
import type {
  IAutoNamer,
  IClaudeLocator,
  IContextMonitor,
  IControlSeamHolder,
  ICwdResolver,
  IDispatcher,
  IEnvComposer,
  IFngitRunner,
  IFragmentLoader,
  IHandoffDetector,
  IHandoffTrigger,
  ILivePermissionReader,
  ILogger,
  IMcpListener,
  INoopSeeder,
  IPlanner,
  IPtyWriterHolder,
  IRingBuffer,
  ISession,
  ISessionIdMinter,
  ISocketPathComputer,
  ITerminalHost,
  IToolHandler,
  IWarningBuffer,
  IWorktreeIntercept,
  IWorktreeLister,
  LaunchInputs,
  LaunchPlan,
  OobeContext,
} from './contracts';

/** File the plan root's services: frozen inputs, the phase services, and the Planner. */
export function registerPlanServices(
  m: Manifest<StandardLifetime>,
  inputs: LaunchInputs,
  cfg: FnConfig,
): Manifest<StandardLifetime> {
  let s = m.addValue<LaunchInputs>(inputs);
  s = s.addValue<FnConfig>(cfg);
  s = s.add<IWarningBuffer>(createPlanWarnings, 'singleton');
  s = s.add<IFileSystem>(NodeFileSystem, 'singleton');
  s = s.add<IProcessSpawner>(NodeSpawner, 'transient');
  s = s.addValue<IWhich>(defaultWhich);
  s = s.add<IWorktreeLister>(createWorktreeLister, 'transient');
  s = s.add<ICwdResolver>((fngit: IFngitRunner | undefined) => createCwdResolver(fngit), 'transient');
  s = s.add<IWorktreeIntercept>(
    (lister: IWorktreeLister) => createWorktreeIntercept(lister),
    'transient',
  );
  s = s.add<IAutoNamer>(createAutoNamer, 'singleton');
  s = s.add<IFragmentLoader>(createFragmentLoader, 'transient');
  s = s.add<ISessionIdMinter>(createSessionIdMinter, 'transient');
  s = s.add<IEnvComposer>(createEnvComposer, 'transient');
  s = s.add<ISocketPathComputer>(createSocketPathComputer, 'transient');
  s = s.add<IClaudeLocator>(createClaudeLocator, 'transient');
  s = s.add<INoopSeeder>(createNoopSeeder, 'transient');
  s = s.add<IPlanner>(Planner, 'singleton');

  // fngit is optional: register the runner only when it is on PATH, so an absent
  // fngit leaves `IFngitRunner | undefined` to self-supply the undefined branch.
  const fngitBin = findFngit();
  if (fngitBin !== null) {
    const runner = makeFngitRunner(fngitBin);
    s = s.addValue<IFngitRunner>({ run: (args) => runner(args) });
  }
  return s;
}

/**
 * File the run root's services (design.di-architecture §4): the always-on session
 * collaborators, plus three conditional overlays — the MCP tool cluster + listener on
 * `plan.mcpEnabled`, the PTY ring + context monitor on `plan.useTerminal`, and the OOBE
 * interview handlers when `oobe` is present. Each `s = s.add(...)` is its own statement
 * (the ttsc fixed-point loop does not converge on a long registration chain, PR-3).
 */
export function registerRunServices(
  m: Manifest<StandardLifetime>,
  plan: LaunchPlan,
  oobe?: OobeContext,
): Manifest<StandardLifetime> {
  // The fnc bin, absolute — the `{bin}` substitution the spawn tool renders. Read from
  // the live argv, as the pre-DI run path did (the plan doesn't carry it).
  const binPath = process.argv[1] ?? '';
  const fncBinAbs = binPath !== '' ? realpathSync(binPath) : '';

  let s = m.addValue<LaunchPlan>(plan);
  s = s.addValue<FnConfig>(plan.config);
  s = s.addValue<XdgEnv>(plan.xdg);
  s = s.addValue<IWhich>(defaultWhich);
  s = s.add<IWarningBuffer>(() => {
    const buffer = createPlanWarnings();
    for (const w of plan.warnings) buffer.add(w);
    return buffer;
  }, 'singleton');
  s = s.add<IFileSystem>(NodeFileSystem, 'singleton');
  s = s.add<IProcessSpawner>(NodeSpawner, 'transient');
  s = s.add<ITerminalHost>(NodeTerminalHost, 'singleton');
  s = s.add<ILogger>(
    () => initLogging({ env: process.env, platform: process.platform, home: plan.xdg.home }).logger,
    'singleton',
  );
  s = s.add<IHandoffTrigger>(createHandoffTrigger, 'singleton');
  s = s.add<IHandoffDetector>((t: IHandoffTrigger) => createHandoffDetector({ trigger: t }), 'singleton');
  s = s.add<ILivePermissionReader>(
    (p: LaunchPlan) => ({ read: (sessionId: string) => readLivePermissionMode(p.launchCWD, sessionId) }),
    'singleton',
  );
  s = s.add<ISession>(Session, 'singleton');

  if (plan.mcpEnabled) {
    s = registerMcpTools(s, plan, oobe, fncBinAbs);
  }
  if (plan.useTerminal) {
    s = s.add<IRingBuffer>(() => new RingBuffer(), 'singleton');
    s = s.add<IContextMonitor>(ContextMonitorService, 'singleton');
  }
  return s;
}

/** File the MCP tool handlers, the dispatcher, and the listener (the `plan.mcpEnabled` overlay). */
function registerMcpTools(
  m: Manifest<StandardLifetime>,
  plan: LaunchPlan,
  oobe: OobeContext | undefined,
  fncBinAbs: string,
): Manifest<StandardLifetime> {
  let s = m.add<IPtyWriterHolder>(createPtyWriterHolder, 'singleton');
  s = s.add<IControlSeamHolder>(createControlSeamHolder, 'singleton');

  s = s.add<IToolHandler>(
    (t: IHandoffTrigger, live: ILivePermissionReader): IToolHandler => ({
      op: 'restart',
      handle: createRestartHandler({
        origArgs: plan.origArgs,
        launchCWD: plan.launchCWD,
        trigger: t,
        livePermissionModeReader: live.read,
      }),
    }),
    'singleton',
  );
  s = s.add<IToolHandler>(
    (t: IHandoffTrigger, live: ILivePermissionReader): IToolHandler => ({
      op: 'switch',
      handle: createSwitchHandler({
        origArgs: plan.origArgs,
        trigger: t,
        livePermissionModeReader: live.read,
      }),
    }),
    'singleton',
  );
  s = s.add<IToolHandler>(
    (): IToolHandler => ({
      op: 'spawn',
      handle: createSpawnHandler({
        config: { autoSpawnCommand: plan.config.autoSpawnCommand },
        processEnv: process.env,
        fncBinPath: fncBinAbs,
        handleCopyToClipboard,
      }),
    }),
    'singleton',
  );
  s = s.add<IToolHandler>(
    (): IToolHandler => ({ op: 'copy_to_clipboard', handle: (req) => handleCopyToClipboard(req) }),
    'singleton',
  );
  s = s.add<IToolHandler>(
    (cs: IControlSeamHolder): IToolHandler => ({
      op: 'compact',
      handle: createRequestCompactHandler({ sendControl: cs.sendControl }),
    }),
    'singleton',
  );
  s = s.add<IToolHandler>(
    (pw: IPtyWriterHolder): IToolHandler => ({ op: 'set_effort', handle: createSetEffortHandler({ write: pw.write }) }),
    'singleton',
  );
  s = s.add<IToolHandler>(
    (pw: IPtyWriterHolder): IToolHandler => ({ op: 'set_model', handle: createSetModelHandler({ write: pw.write }) }),
    'singleton',
  );
  s = s.add<IToolHandler>(
    (pw: IPtyWriterHolder): IToolHandler => ({ op: 'run_slash', handle: createRunSlashCommandHandler({ write: pw.write }) }),
    'singleton',
  );
  s = s.add<IToolHandler>(
    (): IToolHandler => ({ op: 'get_usage', handle: createGetUsageHandler({ launchCWD: plan.launchCWD }) }),
    'singleton',
  );

  if (oobe !== undefined) {
    s = s.add<OobeState>(
      () =>
        new OobeState({
          env: plan.xdg,
          tools: oobe.tools,
          spawnCandidates: oobe.spawnCandidates,
          configured: oobe.configured,
        }),
      'singleton',
    );
    s = s.add<IToolHandler>(
      (st: OobeState, t: IHandoffTrigger): IToolHandler => ({
        op: 'oobe_next',
        handle: createOobeNextHandler(oobeHandlerArgs(st, t, plan, oobe)),
      }),
      'singleton',
    );
    s = s.add<IToolHandler>(
      (st: OobeState, t: IHandoffTrigger): IToolHandler => ({
        op: 'oobe_answer',
        handle: createOobeAnswerHandler(oobeHandlerArgs(st, t, plan, oobe)),
      }),
      'singleton',
    );
    s = s.add<IToolHandler>(
      (st: OobeState, t: IHandoffTrigger): IToolHandler => ({
        op: 'oobe_reask',
        handle: createOobeReaskHandler(oobeHandlerArgs(st, t, plan, oobe)),
      }),
      'singleton',
    );
  }

  s = s.add<IDispatcher>(Dispatcher, 'singleton');
  s = s.add<IMcpListener>(
    (dispatcher: IDispatcher, log: ILogger) => new McpListenerService(plan.socketPath!, dispatcher, log),
    'singleton',
  );
  return s;
}

/**
 * Bind the OOBE interview handlers to one state + trigger: `onApply` runs the setup
 * actions, then relaunches the user's original intent through the same handoff trigger
 * `fnc_restart` uses (mirrors the pre-DI wizard onApply).
 */
function oobeHandlerArgs(
  state: OobeState,
  trigger: IHandoffTrigger,
  plan: LaunchPlan,
  oobe: OobeContext,
): OobeHandlerArgs {
  return {
    state,
    onApply: async () => {
      const { applyAndReport } = await import('../install/run');
      const lines: string[] = [];
      const actions = buildApplyPlan({
        env: plan.xdg,
        answers: state.answersSnapshot(),
        shared: state.sharedAnswers(),
        hasFngit: oobe.tools.fngit,
        hasPlugin: oobe.tools.plugin,
      });
      lines.push('Applying:');
      lines.push(describeApplyPlan(actions));
      await applyAndReport({
        env: plan.xdg,
        actions,
        print: (line) => lines.push(line),
        state,
        packagedPromptsDir: oobe.packagedPromptsDir,
      });
      trigger.stashArgv([...oobe.applyArgv]);
      trigger.fire();
      return { summary: lines.join('\n') };
    },
  };
}
