#!/usr/bin/env bun
// fnclaude entry point — invokes the main run loop.
//
// Bun is the runtime: we rely on Bun.TOML, Bun.spawn, process.execve, and
// node-pty's Bun adaptation. The shebang prefers `bun` directly; PATH
// resolution should pick up the user's mise-managed bun (per project
// CLAUDE.md tooling discipline). When installed via npm, the package's
// `bin` entry rewires to whatever Bun lives in the user's environment.
//
// Module resolution: dist/main.js is what npm-installed users execute;
// local devs running from source use Bun's TS support to import src/main.ts
// directly. We attempt dist first and fall back to src so both workflows
// are first-class without a separate dev shim.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distMain = resolve(here, '..', 'dist', 'main.js');
const srcMain = resolve(here, '..', 'src', 'main.ts');

const target = existsSync(distMain) ? distMain : srcMain;
const { main } = await import(pathToFileURL(target).href);

main();
