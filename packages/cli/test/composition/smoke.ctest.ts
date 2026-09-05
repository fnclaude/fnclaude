// Composition-tier smoke: proves the sugar-bearing lane builds a real container.
//
// This file is authored in the registration dialect (`add<T>(fn, 'singleton')`,
// `resolve<T>()`), so it can only run after tools/build-composition.ts lowers it
// through the ttsc engine — plain `bun test` never sees it (the `.ctest.ts` suffix
// keeps it out of the unit tier). The assertion is the one the validators cannot
// make (design.di-architecture doctrine 1): a singleton resolves to the same
// instance twice.

import { expect, test } from 'bun:test';
import { Builder, standardLifetime, validateBuildability, validateScopes, validateUniversalAddresses } from '@rhombus-std/di';
import type {} from '@rhombus-std/di.extras';
import type { Manifest, StandardLifetime } from '@rhombus-std/di.core';

interface IClock {
  now(): number;
}

function makeClock(): IClock {
  const born = Symbol('clock-instance');
  return { now: () => (born as unknown as { description: string }).description.length };
}

function registerSmokeServices(m: Manifest<StandardLifetime>): Manifest<StandardLifetime> {
  return m.add<IClock>(makeClock, 'singleton');
}

test('the four-addon container resolves a singleton to one shared instance', () => {
  using provider = Builder
    .useAddon(validateUniversalAddresses())
    .useAddon(validateBuildability())
    .useAddon(validateScopes())
    .useAddon(standardLifetime())
    .withServices((m) => registerSmokeServices(m))
    .build();

  const first = provider.resolve<IClock>();
  const second = provider.resolve<IClock>();

  expect(first).toBe(second);
  expect(typeof first.now()).toBe('number');
});
