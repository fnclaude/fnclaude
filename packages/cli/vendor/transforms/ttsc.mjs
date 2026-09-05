// @ts-check
// The ttsc descriptor for the @rhombus-std transform engine. ttsc loads this
// module, calls it, and gets back the ABSOLUTE PATH to the Go host under
// cmd/ttsc-std; ttsc then compiles and runs that source as a sidecar with the
// Go toolchain it resolves for itself.
//
// Every @rhombus-std authoring package re-exports this one descriptor, so all
// of them name the same host directory under the same name and ttsc dedupes
// them to one cache key and one spawn. The name is a spawn identifier, not a
// stage selector: the host runs its whole stage table on every file.

import path from 'node:path';

/**
 * @returns {import("ttsc").ITtscPlugin}
 */
export function createTtscPlugin() {
  // Anchored on this file rather than on the factory context's `dirname`, which
  // names whichever re-exporting descriptor ttsc loaded.
  const source = path.join(import.meta.dirname, 'cmd', 'ttsc-std');
  return { name: 'rhombusstd', source };
}

export default createTtscPlugin;
