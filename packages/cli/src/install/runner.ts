/**
 * The install runner (design.di-architecture §4, install root).
 *
 * Wraps the unchanged `runInstallNonInteractive` leaf behind {@link IInstallRunner}:
 * sugar-free, async work in the `run()` method (doctrine 9c), constructed synchronously.
 */

import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';

import { configuredPaths } from '../config/configured';
import { resolvePromptsDir } from '../prompts/dir';
import { runInstallNonInteractive } from './run';

import type { XdgEnv } from '../config/paths';
import type { InstallFlags } from './subcommand';
import type { IInstallRunner } from '../launch/contracts';

/** The frozen inputs a `fnc install -y` mini-root is built from. */
export interface InstallInputs {
  readonly flags: InstallFlags;
  readonly xdg: XdgEnv;
  readonly binPath: string;
  readonly shellCwd: string;
}

/** The install runner: resolves the packaged prompts dir, then applies the non-interactive plan. */
export function createInstallRunner(inputs: InstallInputs): IInstallRunner {
  return {
    run: async () => {
      const exeDir = inputs.binPath !== '' ? dirname(realpathSync(inputs.binPath)) : inputs.shellCwd;
      const packaged = resolvePromptsDir({
        envOverride: process.env.FNC_PROMPTS_DIR,
        exeDir,
      });
      const result = await runInstallNonInteractive({
        env: inputs.xdg,
        flags: inputs.flags,
        configured: await configuredPaths(inputs.xdg),
        packagedPromptsDir: packaged.dir,
      });
      return result.exitCode;
    },
  };
}
