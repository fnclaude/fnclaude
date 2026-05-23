#!/usr/bin/env node
// Umbrella shim: delegates to @fnclaude/cli's bin. The shim pattern is
// deliberate — npm's `bin` field pointing into a dependency is undefined
// behavior, but a thin wrapper that requires the dep is documented and
// portable.
import('@fnclaude/cli/bin/fnc.js');
