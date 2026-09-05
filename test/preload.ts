// Root-level bun test preload.
//
// Bun loads bunfig.toml only from the invocation directory, not from any
// ancestor or per-package location. Forcing colour on here keeps a root
// `bun test` behaving the same as the per-package `moon run :test`
// invocations for any test that asserts on ANSI styling. No package
// currently depends on FORCE_COLOR, so this is a no-op for them.

process.env.FORCE_COLOR = "1";
