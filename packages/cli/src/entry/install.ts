/**
 * Install root (design.di-architecture §2b): the `fnc install -y` mini-root.
 *
 * A plain Builder container that resolves the install runner and returns its exit code.
 */

import {
  Builder,
  standardLifetime,
  validateBuildability,
  validateScopes,
  validateUniversalAddresses,
} from '@rhombus-std/di';
import type {} from '@rhombus-std/di.extras';

import { registerInstallServices } from '../install/register';
import type { InstallInputs } from '../install/runner';
import type { IInstallRunner } from '../launch/contracts';

export type { InstallInputs } from '../install/runner';

/** Build the install mini-root, run the non-interactive install, and return its exit code. */
export async function runInstall(inputs: InstallInputs): Promise<number> {
  await using provider = Builder.useAddon(validateUniversalAddresses())
    .useAddon(validateBuildability())
    .useAddon(validateScopes())
    .useAddon(standardLifetime())
    .withServices((m) => registerInstallServices(m, inputs))
    .build();
  return await provider.resolve<IInstallRunner>().run();
}
