/**
 * MCP-root registrations (design.di-architecture §4, MCP root).
 *
 * Files the `fnc mcp` subprocess's services: the frozen flags, the XDG env, the
 * function-shaped wire seam (value door), the consolidated version reader, the
 * file-only logger that closes the previously-unlogged-subprocess gap, and the
 * stdio pump that wires them into the JSON-RPC server.
 */

import type { Manifest, StandardLifetime } from '@rhombus-std/di.core';
import type {} from '@rhombus-std/di.extras';

import { createVersionReader } from '../composition/version-reader';
import { initLogging } from '../log/init';
import { type McpFlags } from './dispatch';
import { McpPump } from './IMcpPump';
import { dialAndCall } from './wire';

import type { XdgEnv } from '../config/paths';
import type { IVersionReader } from '../composition/version-reader';
import type { Logger } from '../log/logger';
import type { IMcpPump } from './IMcpPump';
import type { IWireClient } from './wire';

/** The frozen argv/env product the MCP subprocess composes against. */
export interface McpInputs {
  flags: McpFlags;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  xdg: XdgEnv;
}

/** File the MCP subprocess's services from `inputs`. */
export function registerMcpServices(
  m: Manifest<StandardLifetime>,
  inputs: McpInputs,
): Manifest<StandardLifetime> {
  let s = m.addValue<McpFlags>(inputs.flags);
  s = s.addValue<XdgEnv>(inputs.xdg);
  s = s.addValue<IWireClient>(dialAndCall);
  s = s.add<IVersionReader>(createVersionReader, 'singleton');
  s = s.add<Logger>(
    (xdg: XdgEnv) => initLogging({ env: inputs.env, platform: inputs.platform, home: xdg.home }).logger,
    'singleton',
  );
  s = s.add<IMcpPump>(
    (wire: IWireClient, version: IVersionReader, logger: Logger, flags: McpFlags) =>
      new McpPump({ wire, version, logger, flags, env: inputs.env }),
    'singleton',
  );
  return s;
}
