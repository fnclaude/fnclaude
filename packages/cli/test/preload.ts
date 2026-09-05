// Package-level bun test preload (wired via packages/cli/bunfig.toml).
//
// Runs once per `bun test` process, before any test file loads, so the lowered dist/ is
// built before the e2e/unit tiers spawn bin/fnc.js. Without this, a cold checkout rebuilds
// dist inside every spawned shim concurrently and the spawns time out — see ensure-dist.ts.

import { ensureDist } from './fixtures/ensure-dist.ts';

await ensureDist();
