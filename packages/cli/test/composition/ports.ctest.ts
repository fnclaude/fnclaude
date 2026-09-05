// Composition tier for the ports layer (design.di-architecture §5, PR-2).
//
// Authored in the registration dialect (`add<T>`, `addValue<T>`, `resolve<T>`),
// so it runs only after tools/build-composition.ts lowers it — plain `bun test`
// never sees a `.ctest.ts`. Three things the validators cannot assert on their
// own: that a `Symbol.asyncDispose` adapter's `stop()` runs on `await using`,
// that an unregistered factory dependency fails `build()`, and that the node
// adapters wire (the value door hands a function-shaped seam back as itself).

import { expect, test } from 'bun:test';
import { Builder, standardLifetime, validateBuildability, validateScopes, validateUniversalAddresses } from '@rhombus-std/di';
import { ManifestValidationError } from '@rhombus-std/di.core';
import type {} from '@rhombus-std/di.extras';
import type { Manifest, StandardLifetime } from '@rhombus-std/di.core';

import type { IClock, IEnvironment, IFileSystem, IProcessSpawner, IWhich } from '../../src/ports/contracts';
import { asAsyncDisposable } from '../../src/ports/disposal';
import { SystemClock } from '../../src/ports/node-clock';
import { readNodeEnvironment } from '../../src/ports/node-env';
import { NodeFileSystem } from '../../src/ports/node-fs';
import { NodeSpawner } from '../../src/ports/node-spawner';
import { defaultWhich } from '../../src/ports/node-which';

function newBuilder() {
  return Builder
    .useAddon(validateUniversalAddresses())
    .useAddon(validateBuildability())
    .useAddon(validateScopes())
    .useAddon(standardLifetime());
}

interface IStoppableProbe {
  readonly value: number;
  stop(): Promise<void>;
}

test('await using runs an adapted disposable\'s stop() on teardown', async () => {
  let stopped = false;
  const probe: IStoppableProbe = {
    value: 7,
    stop: async () => {
      stopped = true;
    },
  };

  {
    await using provider = newBuilder()
      .withServices((m: Manifest<StandardLifetime>) =>
        m.add<IStoppableProbe>(() => asAsyncDisposable(probe), 'singleton'),
      )
      .build();
    // Resolve to construct the singleton, which captures it for teardown.
    expect(provider.resolve<IStoppableProbe>().value).toBe(7);
    expect(stopped).toBe(false);
  } // provider disposed here — its LIFO teardown awaits Symbol.asyncDispose

  expect(stopped).toBe(true);
});

interface IDependency {
  readonly tag: string;
}

interface IConsumer {
  readonly dep: IDependency;
}

test('build() throws ManifestValidationError when a factory dependency is unregistered', () => {
  const buildBroken = () =>
    newBuilder()
      .withServices((m: Manifest<StandardLifetime>) =>
        m.add<IConsumer>((dep: IDependency) => ({ dep }), 'singleton'),
      )
      .build();

  expect(buildBroken).toThrow(ManifestValidationError);
});

test('build() succeeds once that dependency is registered (proves the throw is the missing dep)', () => {
  using provider = newBuilder()
    .withServices((m: Manifest<StandardLifetime>) =>
      m
        .add<IDependency>(() => ({ tag: 'ok' }), 'singleton')
        .add<IConsumer>((dep: IDependency) => ({ dep }), 'singleton'),
    )
    .build();

  expect(provider.resolve<IConsumer>().dep.tag).toBe('ok');
});

test('the node adapters wire through the container', () => {
  using provider = newBuilder()
    .withServices((m: Manifest<StandardLifetime>) =>
      m
        .add<IFileSystem>(NodeFileSystem, 'singleton')
        .add<IClock>(SystemClock, 'singleton')
        .add<IProcessSpawner>(NodeSpawner, 'singleton')
        .add<IEnvironment>(readNodeEnvironment, 'singleton')
        .addValue<IWhich>(defaultWhich),
    )
    .build();

  expect(provider.resolve<IFileSystem>()).toBeInstanceOf(NodeFileSystem);
  expect(typeof provider.resolve<IClock>().now()).toBe('number');
  expect(provider.resolve<IProcessSpawner>()).toBeInstanceOf(NodeSpawner);
  expect(provider.resolve<IEnvironment>().home.length).toBeGreaterThan(0);
  // Value door: the function-shaped seam is handed back as itself, never called.
  expect(provider.resolve<IWhich>()).toBe(defaultWhich);
});
