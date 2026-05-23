#!/usr/bin/env node
// Placeholder entry — real CLI lands when the Go port arrives.
// See packages/cli/src/index.ts for the library export.
import('../dist/index.js').then(({ name }) => {
  console.log(`${name} (placeholder)`);
});
