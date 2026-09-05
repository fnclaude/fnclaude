/**
 * The real {@link ITerminalHost} over `Bun.Terminal` + `process` stdin/stdout — the
 * single seam that lets the session's PTY branch be exercised without a live TTY
 * (design.di-architecture §5).
 */

import type { ITerminalHost } from '../launch/contracts';

export class NodeTerminalHost implements ITerminalHost {
  createTerminal(cols: number, rows: number, onData: (chunk: Uint8Array) => void): Bun.Terminal {
    return new Bun.Terminal({
      cols,
      rows,
      data: (_terminal, chunk) => {
        process.stdout.write(chunk);
        onData(chunk);
      },
    });
  }

  columns(): number {
    return process.stdout.columns ?? 80;
  }

  rows(): number {
    return process.stdout.rows ?? 24;
  }

  setRawMode(on: boolean): void {
    process.stdin.setRawMode(on);
  }

  onStdinData(listener: (chunk: Buffer) => void): void {
    process.stdin.on('data', listener);
  }

  onStdoutResize(listener: () => void): void {
    process.stdout.on('resize', listener);
  }

  pauseStdin(): void {
    process.stdin.pause();
  }
}
