import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findPromptsDir,
  isInteractiveSession,
  loadPrompts,
  type PromptSet,
  readPromptFile,
  readPromptFileSync,
  selectFragments,
} from '../src/prompts.js';

// Mirrors src/prompts_test.go. Tests use FNC_PROMPTS_DIR for deterministic
// behaviour rather than mocking exe-sibling lookups.

let tmp: string;
const prevEnv = process.env.FNC_PROMPTS_DIR;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'fnc-prompts-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (prevEnv === undefined) {
    delete process.env.FNC_PROMPTS_DIR;
  } else {
    process.env.FNC_PROMPTS_DIR = prevEnv;
  }
});

describe('findPromptsDir', () => {
  test('FNC_PROMPTS_DIR override returns the env path', () => {
    process.env.FNC_PROMPTS_DIR = tmp;
    const result = findPromptsDir();
    expect(result.dir).toBe(tmp);
    expect(result.error).toBeNull();
  });

  test('FNC_PROMPTS_DIR pointing at missing dir errors', () => {
    process.env.FNC_PROMPTS_DIR = '/nonexistent/path/should/not/exist';
    const result = findPromptsDir();
    expect(result.dir).toBeNull();
    expect(result.error).not.toBeNull();
    expect(result.error!).toContain('FNC_PROMPTS_DIR');
  });

  test('with no env override and no neighbour dir, returns descriptive error', () => {
    delete process.env.FNC_PROMPTS_DIR;
    const result = findPromptsDir();
    // In CI the test-runner exe's neighbours don't contain a prompts dir;
    // if they happen to (dev workstation that bundled one), skip.
    if (result.dir !== null) {
      return;
    }
    expect(result.error).toContain('prompts directory not found');
  });
});

describe('readPromptFileSync', () => {
  test('reads valid file and trims trailing whitespace', () => {
    writeFileSync(join(tmp, 'x.md'), 'hello world\n\n');
    const { content, warning } = readPromptFileSync(tmp, 'x.md');
    expect(content).toBe('hello world');
    expect(warning).toBeNull();
  });

  test('missing file returns empty content + warning mentioning path and recovery hint', () => {
    const { content, warning } = readPromptFileSync(tmp, 'missing.md');
    expect(content).toBe('');
    expect(warning).not.toBeNull();
    expect(warning!).toContain(join(tmp, 'missing.md'));
    expect(warning!).toContain('missing.md');
    expect(warning!).toContain('FNC_PROMPTS_DIR');
  });
});

describe('readPromptFile (async)', () => {
  test('reads valid file and trims trailing whitespace', async () => {
    writeFileSync(join(tmp, 'x.md'), 'hello world\n\n');
    const { content, warning } = await readPromptFile(tmp, 'x.md');
    expect(content).toBe('hello world');
    expect(warning).toBeNull();
  });

  test('missing file returns empty content + warning', async () => {
    const { content, warning } = await readPromptFile(tmp, 'missing.md');
    expect(content).toBe('');
    expect(warning).not.toBeNull();
    expect(warning!).toContain('missing.md');
  });
});

describe('loadPrompts', () => {
  test('all files present populates every fragment', () => {
    const files: Record<string, string> = {
      'agent-pitfall.md': 'pitfall content',
      'project-switch.md': 'switch content',
      'spawn.md': 'spawn content',
      'restart.md': 'restart content',
      'noop-router.md': 'router content',
    };
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(tmp, name), body);
    }
    process.env.FNC_PROMPTS_DIR = tmp;

    const { prompts, warnings } = loadPrompts();
    expect(prompts.agentPitfall).toBe('pitfall content');
    expect(prompts.projectSwitch).toBe('switch content');
    expect(prompts.spawn).toBe('spawn content');
    expect(prompts.restart).toBe('restart content');
    expect(prompts.noopRouter).toBe('router content');
    expect(warnings).toHaveLength(0);
  });

  test('missing dir returns empty PromptSet with actionable warning', () => {
    process.env.FNC_PROMPTS_DIR = '/nonexistent/path';
    const { prompts, warnings } = loadPrompts();
    expect(prompts.agentPitfall).toBe('');
    expect(prompts.projectSwitch).toBe('');
    expect(prompts.spawn).toBe('');
    expect(prompts.restart).toBe('');
    expect(prompts.noopRouter).toBe('');
    expect(warnings.length).toBeGreaterThan(0);
    const w = warnings[0]!;
    expect(w).toContain('/nonexistent/path');
    expect(w).toContain('FNC_PROMPTS_DIR');
    expect(w).toContain('AUR');
    expect(w).toContain('go install');
  });

  test('partial files populate present, warn on missing', () => {
    writeFileSync(join(tmp, 'agent-pitfall.md'), 'ap');
    process.env.FNC_PROMPTS_DIR = tmp;

    const { prompts, warnings } = loadPrompts();
    expect(prompts.agentPitfall).toBe('ap');
    expect(prompts.projectSwitch).toBe('');
    expect(prompts.spawn).toBe('');
    expect(prompts.restart).toBe('');
    expect(prompts.noopRouter).toBe('');
    // Four missing files = four warnings.
    expect(warnings).toHaveLength(4);
  });
});

// ── isInteractiveSession ───────────────────────────────────────────────────

describe('isInteractiveSession', () => {
  test('true when no -p / --print present', () => {
    expect(isInteractiveSession(['--verbose', '--model', 'sonnet'])).toBe(true);
  });

  test('false when -p present', () => {
    expect(isInteractiveSession(['-p', 'do thing'])).toBe(false);
  });

  test('false when --print present', () => {
    expect(isInteractiveSession(['--print', 'do thing'])).toBe(false);
  });

  test('true for empty passthrough', () => {
    expect(isInteractiveSession([])).toBe(true);
  });
});

// ── selectFragments ────────────────────────────────────────────────────────

const fullPromptSet: PromptSet = {
  agentPitfall: 'AP',
  projectSwitch: 'PS',
  spawn: 'SP',
  restart: 'RS',
  noopRouter: 'NR',
};

describe('selectFragments', () => {
  test('-p mode returns nothing', () => {
    expect(selectFragments(fullPromptSet, ['-p', 'prompt'], false)).toEqual([]);
  });

  test('project session: pitfall + spawn + project-switch + restart, in order', () => {
    expect(selectFragments(fullPromptSet, ['--verbose'], false)).toEqual([
      'AP',
      'SP',
      'PS',
      'RS',
    ]);
  });

  test('noop session: pitfall + spawn + noop-router (no switch/restart)', () => {
    expect(selectFragments(fullPromptSet, [], true)).toEqual(['AP', 'SP', 'NR']);
  });

  test('empty PromptSet returns nothing', () => {
    const empty: PromptSet = {
      agentPitfall: '',
      projectSwitch: '',
      spawn: '',
      restart: '',
      noopRouter: '',
    };
    expect(selectFragments(empty, ['--verbose'], false)).toEqual([]);
  });

  test('missing project-switch in project session drops just that fragment', () => {
    const ps: PromptSet = {
      agentPitfall: 'AP',
      projectSwitch: '',
      spawn: '',
      restart: '',
      noopRouter: '',
    };
    expect(selectFragments(ps, ['--verbose'], false)).toEqual(['AP']);
  });

  test('missing noop-router in noop session drops just that fragment', () => {
    const ps: PromptSet = {
      agentPitfall: 'AP',
      projectSwitch: '',
      spawn: '',
      restart: '',
      noopRouter: '',
    };
    expect(selectFragments(ps, [], true)).toEqual(['AP']);
  });
});

// ── installed-package layout regression ────────────────────────────────────
//
// Defect: prior to shipping prompts/ in the npm package, a global install
// (`npm i -g @fnclaude/cli`) put bin/fnc.js on disk with no sibling prompts/,
// so findPromptsDir() returned an error and every session emitted a "prompts
// directory not found" warning. Cover both halves of the fix here:
//   (a) the resolver knows to look at <exe-dir>/../prompts/ (the package
//       root, one level up from bin/);
//   (b) the package manifest's `files` array still includes "prompts" so
//       it actually ships in the tarball.

describe('npm-installed package layout', () => {
  test('findPromptsDir resolves prompts/ at <exe-dir>/../prompts/', () => {
    delete process.env.FNC_PROMPTS_DIR;

    // Simulate the installed shape: <pkg>/bin/fnc.js with <pkg>/prompts/.
    const fakePkg = mkdtempSync(join(tmpdir(), 'fnc-pkg-'));
    const binDir = join(fakePkg, 'bin');
    const promptsDir = join(fakePkg, 'prompts');
    mkdirSync(binDir);
    mkdirSync(promptsDir);
    const fakeBin = join(binDir, 'fnc.js');
    writeFileSync(fakeBin, '// placeholder');
    writeFileSync(join(promptsDir, 'agent-pitfall.md'), 'AP');

    const savedArgv1 = process.argv[1];
    process.argv[1] = fakeBin;
    try {
      const result = findPromptsDir();
      expect(result.error).toBeNull();
      expect(result.dir).toBe(promptsDir);
    } finally {
      if (savedArgv1 === undefined) {
        process.argv.length = 1;
      } else {
        process.argv[1] = savedArgv1;
      }
      rmSync(fakePkg, { recursive: true, force: true });
    }
  });

  test('package.json declares prompts/ in the files array', () => {
    // The resolver above only helps if the directory actually ships. Without
    // "prompts" in the files array, npm publish drops it and registry users
    // hit the "prompts directory not found" warning again.
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('prompts');
  });
});
