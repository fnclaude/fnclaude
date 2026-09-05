// Root-level bun test preload.
//
// Bun loads bunfig.toml only from the invocation directory, not from any
// ancestor or per-package location. Forcing colour on here keeps a root
// `bun test` behaving the same as the per-package `moon run :test`
// invocations for any test that asserts on ANSI styling. No package
// currently depends on FORCE_COLOR, so this is a no-op for them.

import { ensureDist } from "../packages/cli/test/fixtures/ensure-dist.ts";

process.env.FORCE_COLOR = "1";

// A root `bun test` also scans packages/cli's e2e/unit tiers, which spawn bin/fnc.js.
// Build the CLI's lowered dist once up front (same guarantee as its package preload) so a
// cold checkout doesn't rebuild it inside every spawned process concurrently. Idempotent
// and cheap when warm.
await ensureDist();
