/**
 * Install-root registrations (design.di-architecture §4, install root).
 *
 * Files the `fnc install -y` mini-root's services: the frozen flags and XDG env, a
 * filesystem seam, and the install runner that wraps the leaf.
 */

import type { Manifest, StandardLifetime } from '@rhombus-std/di.core';
import type {} from '@rhombus-std/di.extras';

import { NodeFileSystem } from '../ports/node-fs';
import { createInstallRunner, type InstallInputs } from './runner';

import type { XdgEnv } from '../config/paths';
import type { IFileSystem } from '../ports/contracts';
import type { IInstallRunner } from '../launch/contracts';
import type { InstallFlags } from './subcommand';

/** File the install mini-root's services from `inputs`. */
export function registerInstallServices(
  m: Manifest<StandardLifetime>,
  inputs: InstallInputs,
): Manifest<StandardLifetime> {
  return m
    .addValue<InstallFlags>(inputs.flags)
    .addValue<XdgEnv>(inputs.xdg)
    .add<IFileSystem>(NodeFileSystem, 'singleton')
    .add<IInstallRunner>(() => createInstallRunner(inputs), 'singleton');
}
