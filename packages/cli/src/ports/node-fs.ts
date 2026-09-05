import { statSync } from 'node:fs';

import type { IFileSystem } from './contracts';

/** The real {@link IFileSystem} over `node:fs` and `Bun.file`. */
export class NodeFileSystem implements IFileSystem {
  isFile(path: string): boolean {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  }

  readText(path: string): Promise<string> {
    return Bun.file(path).text();
  }
}
