// Composition tier for the mcp root (design.di-architecture §9 PR-5).
//
// Authored in the registration dialect, so it runs only after the composition
// lane lowers it. Two things the validators cannot assert on their own: that the
// real mcp container builds and validates, and the resolve-twice identity of
// every shared singleton (the wrong-lifetime guard, doctrine 1). The env sets
// FNC_LOG=silent so the logger factory stays hermetic (no log dir touched).

import { expect, test } from 'bun:test';
import {
  Builder,
  standardLifetime,
  validateBuildability,
  validateScopes,
  validateUniversalAddresses,
} from '@rhombus-std/di';
import type {} from '@rhombus-std/di.extras';

import { registerMcpServices, type McpInputs } from '../../src/mcp/register';
import type { IVersionReader } from '../../src/composition/version-reader';
import type { Logger } from '../../src/log/logger';
import type { IMcpPump } from '../../src/mcp/IMcpPump';

function newBuilder() {
  return Builder.useAddon(validateUniversalAddresses())
    .useAddon(validateBuildability())
    .useAddon(validateScopes())
    .useAddon(standardLifetime());
}

function fakeInputs(): McpInputs {
  return {
    flags: { noop: false },
    env: { FNC_LOG: 'silent' },
    platform: 'linux',
    xdg: { home: '/home/ctest', xdgConfigHome: undefined, xdgStateHome: undefined },
  };
}

test('the mcp container builds, validates, and resolves the pump', () => {
  using provider = newBuilder()
    .withServices((m) => registerMcpServices(m, fakeInputs()))
    .build();
  expect(typeof provider.resolve<IMcpPump>().run).toBe('function');
});

test('every shared singleton resolves to one instance', () => {
  using provider = newBuilder()
    .withServices((m) => registerMcpServices(m, fakeInputs()))
    .build();
  expect(provider.resolve<IMcpPump>()).toBe(provider.resolve<IMcpPump>());
  expect(provider.resolve<IVersionReader>()).toBe(provider.resolve<IVersionReader>());
  expect(provider.resolve<Logger>()).toBe(provider.resolve<Logger>());
});
