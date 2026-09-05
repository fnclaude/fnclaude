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

import { NodeFileSystem } from '../ports/node-fs';
import { NodeSpawner } from '../ports/node-spawner';
import { defaultWhich } from '../ports/node-which';
import { findFngit, makeFngitRunner } from '../repo/fngit';
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
import { createPlanWarnings } from './plan-warnings';

import type { FnConfig } from '../config/load';
import type { IFileSystem, IProcessSpawner, IWhich } from '../ports/contracts';
import type {
  IAutoNamer,
  IClaudeLocator,
  ICwdResolver,
  IEnvComposer,
  IFngitRunner,
  IFragmentLoader,
  INoopSeeder,
  IPlanner,
  ISessionIdMinter,
  ISocketPathComputer,
  IWarningBuffer,
  IWorktreeIntercept,
  IWorktreeLister,
  LaunchInputs,
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
