import { homedir } from 'node:os';

import type { IEnvironment } from './contracts';

/** Snapshot the process environment once into a frozen {@link IEnvironment}. */
export function readNodeEnvironment(): IEnvironment {
  const env = process.env;
  return Object.freeze({
    home: env.HOME ?? homedir(),
    get(name: string): string | undefined {
      return env[name];
    },
  });
}
