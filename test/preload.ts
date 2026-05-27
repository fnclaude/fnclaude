// Monorepo-root test preload — runs before any test file imports when
// `bun test` is invoked from the repo root.
//
// Bun loads bunfig.toml only from the invocation directory, not from any
// ancestor or per-package location. CI runs tests via `moon run :test`,
// which cd's into each package, so `packages/renderer/bunfig.toml` (and
// its preload that sets FORCE_COLOR=1) is picked up correctly. But the
// project's TDD workflow has users running `bun test` from the repo
// root, where no bunfig is loaded and the renderer's ANSI-asserting
// tests fail because chalk auto-strips escapes in non-TTY mode.
//
// Setting FORCE_COLOR=1 here makes root-invocation behave identically to
// per-package invocation for the renderer's styling assertions. Other
// packages don't depend on FORCE_COLOR, so this is a no-op for them.

process.env.FORCE_COLOR = "1";
