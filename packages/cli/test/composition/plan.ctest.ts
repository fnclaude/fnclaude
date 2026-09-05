// Composition tier for the plan root (design.di-architecture §9 PR-3).
//
// Authored in the registration dialect, so it runs only after the composition lane
// lowers it. Four things the validators cannot assert on their own: that the real
// plan container builds and validates, that a missing phase service fails build(),
// that the emitted plan is deep-frozen and ref-free (survives disposal), and that
// config carries whole while plan-phase warnings drain onto the plan.

import { expect, test } from 'bun:test';
import {
  Builder,
  standardLifetime,
  validateBuildability,
  validateScopes,
  validateUniversalAddresses,
} from '@rhombus-std/di';
import { ManifestValidationError } from '@rhombus-std/di.core';
import type {} from '@rhombus-std/di.extras';
import type { Manifest, StandardLifetime } from '@rhombus-std/di.core';

import type { FnConfig } from '../../src/config/load';
import { registerPlanServices } from '../../src/launch/register';
import { Planner } from '../../src/launch/planner';
import type { IPlanner, IWarningBuffer, LaunchInputs } from '../../src/launch/contracts';

function newBuilder() {
  return Builder.useAddon(validateUniversalAddresses())
    .useAddon(validateBuildability())
    .useAddon(validateScopes())
    .useAddon(standardLifetime());
}

/** Inputs that keep the pipeline hermetic: an absolute path (no fngit), disabled auto-name/id. */
function fakeInputs(): LaunchInputs {
  return {
    argv: ['/tmp/fnc-ctest-cwd', '-w', 'has spaces!'],
    shellCwd: '/tmp',
    home: '/home/ctest',
    xdg: { home: '/home/ctest', xdgConfigHome: undefined, xdgStateHome: undefined },
    env: {
      PATH: '',
      FNC_INTERNAL_DISABLE_AUTONAME: '1',
      FNC_INTERNAL_DISABLE_SESSION_ID: '1',
    },
    platform: 'linux',
    pid: 4242,
    execPath: '/usr/bin/bun',
    binPath: '',
    stdinIsTTY: false,
    stdoutIsTTY: false,
  };
}

function fakeConfig(): FnConfig {
  return {
    noOobe: false,
    noopDir: undefined,
    autoTmux: undefined,
    autoHandoff: undefined,
    autoSpawnCommand: 'CARRY_ME',
    claudeDefaultArgs: undefined,
    contextNoticeThreshold: undefined,
    contextNoticeLadder: undefined,
    execEnv: undefined,
  };
}

test('the plan container builds, validates, and resolves the Planner', () => {
  using provider = newBuilder()
    .withServices((m) => registerPlanServices(m, fakeInputs(), fakeConfig()))
    .build();
  expect(typeof provider.resolve<IPlanner>().plan).toBe('function');
});

test('build() fails when a phase service the Planner names is missing', () => {
  const buildBroken = () =>
    newBuilder()
      .withServices((m: Manifest<StandardLifetime>) =>
        m
          .addValue<LaunchInputs>(fakeInputs())
          .addValue<FnConfig>(fakeConfig())
          .add<IWarningBuffer>(() => ({ add: () => {}, drain: () => [] }), 'singleton')
          .add<IPlanner>(Planner, 'singleton'),
      )
      .build();
  expect(buildBroken).toThrow(ManifestValidationError);
});

test('the emitted plan is deep-frozen, carries config whole, and drains phase warnings', async () => {
  let plan;
  {
    await using provider = newBuilder()
      .withServices((m) => registerPlanServices(m, fakeInputs(), fakeConfig()))
      .build();
    plan = await provider.resolve<IPlanner>().plan();
  } // container disposed here — the plan must survive it

  // Ref-free: plain data read after disposal.
  expect(plan.launchCWD).toBe('/tmp/fnc-ctest-cwd');
  // Config carried whole.
  expect(plan.config.autoSpawnCommand).toBe('CARRY_ME');
  // Plan-phase warnings drained onto the plan (the -w sanitization warning survives).
  expect(plan.warnings.some((w) => /sanitized|illegal/.test(w))).toBe(true);
  // Deep-frozen: the plan and its nested arrays/records are frozen.
  expect(Object.isFrozen(plan)).toBe(true);
  expect(Object.isFrozen(plan.claudeArgv)).toBe(true);
  expect(Object.isFrozen(plan.config)).toBe(true);
});
