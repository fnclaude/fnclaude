import type { InheritSpawnOptions, IProcessSpawner, PtySpawnOptions } from './contracts';

/** The real {@link IProcessSpawner} over `Bun.spawn`. */
export class NodeSpawner implements IProcessSpawner {
  spawnPty(command: readonly string[], options: PtySpawnOptions): Bun.Subprocess {
    return Bun.spawn([...command], {
      cwd: options.cwd,
      env: options.env,
      terminal: options.terminal,
    });
  }

  spawnInherit(command: readonly string[], options: InheritSpawnOptions): Bun.Subprocess {
    return Bun.spawn([...command], {
      cwd: options.cwd,
      env: options.env,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
  }
}
