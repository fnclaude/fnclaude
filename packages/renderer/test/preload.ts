// Test preload — runs before any test file imports.
//
// Forces chalk (transitive via Ink) to emit ANSI escape codes in the
// non-TTY test runner so renderer tests can assert styling. Chalk
// inspects FORCE_COLOR at module-load time, which is why this has to be
// a preload — setting it inside a test's beforeAll() is too late.

process.env.FORCE_COLOR = "1";
