import { describe, expect, test } from 'bun:test';

import {
  applyTemplate,
  cloneTemplateVars,
  deriveWorktreeMarker,
  type TemplateVars,
} from '../../src/repo/template';

const ok = (s: string) => ({ ok: true as const, value: s });

describe('applyTemplate — substitution', () => {
  test('every variable resolved', () => {
    const vars: TemplateVars = {
      repo: () => ok('myrepo'),
      owner: () => ok('myorg'),
    };
    expect(applyTemplate('~/src/{repo}@{owner}', vars)).toEqual(ok('~/src/myrepo@myorg'));
  });

  test('unknown placeholder errors with the placeholder name', () => {
    const vars: TemplateVars = {
      repo: () => ok('x'),
    };
    const r = applyTemplate('{repo}/{unknown}', vars);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('{unknown}');
  });

  test('lazy resolver not called when not referenced', () => {
    let called = false;
    const vars: TemplateVars = {
      repo: () => ok('x'),
      owner: () => {
        called = true;
        return ok('');
      },
    };
    applyTemplate('{repo}', vars);
    expect(called).toBe(false);
  });

  test('resolver error propagated', () => {
    const vars: TemplateVars = {
      x: () => ({ ok: false, error: 'boom' }),
    };
    const r = applyTemplate('{x}', vars);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('boom');
  });

  test('unterminated brace passes through literally', () => {
    expect(applyTemplate('foo{unclosed', {})).toEqual(ok('foo{unclosed'));
  });

  test('no placeholders: pass through verbatim', () => {
    expect(applyTemplate('plain string', {})).toEqual(ok('plain string'));
  });

  test('empty string: empty output', () => {
    expect(applyTemplate('', {})).toEqual(ok(''));
  });

  test('multiple references to the same placeholder', () => {
    const vars: TemplateVars = { x: () => ok('hi') };
    expect(applyTemplate('{x} {x} {x}', vars)).toEqual(ok('hi hi hi'));
  });
});

describe('cloneTemplateVars', () => {
  test('repo + owner basic substitution', () => {
    const vars = cloneTemplateVars('myrepo', 'myorg', 'github.com', { 'github.com': 'gh' });
    expect(applyTemplate('~/src/{repo}@{owner}', vars)).toEqual(ok('~/src/myrepo@myorg'));
  });

  test('host-plain strips the TLD', () => {
    const vars = cloneTemplateVars('r', 'o', 'github.com', {});
    expect(applyTemplate('{host-plain}', vars)).toEqual(ok('github'));
  });

  test('host-plain falls back to full host when no dot', () => {
    const vars = cloneTemplateVars('r', 'o', 'localhost', {});
    expect(applyTemplate('{host-plain}', vars)).toEqual(ok('localhost'));
  });

  test('host-short hit', () => {
    const vars = cloneTemplateVars('r', 'o', 'github.com', {
      'github.com': 'gh',
      'gitlab.com': 'gl',
    });
    expect(applyTemplate('{host-short}', vars)).toEqual(ok('gh'));
  });

  test('host-short miss: error names the host', () => {
    const vars = cloneTemplateVars('r', 'o', 'github.example.com', {
      'github.com': 'gh',
    });
    const r = applyTemplate('{host-short}', vars);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('github.example.com');
  });

  test('host-short LUT miss does NOT error if not referenced', () => {
    const vars = cloneTemplateVars('r', 'o', 'weird.host.example', {});
    expect(applyTemplate('{repo}@{owner}', vars)).toEqual(ok('r@o'));
  });

  test('full repoSettings example with all placeholders', () => {
    const vars = cloneTemplateVars('arch-setup', 'fnrhombus', 'github.com', {
      'github.com': 'gh',
    });
    expect(
      applyTemplate('~/src/{host-short}/{owner}/{repo}', vars),
    ).toEqual(ok('~/src/gh/fnrhombus/arch-setup'));
  });
});

describe('deriveWorktreeMarker', () => {
  test('worktreeTemplate suffixes cloneTemplate: literal before placeholder is the marker', () => {
    expect(deriveWorktreeMarker('~/src/{repo}@{owner}', '~/src/{repo}@{owner}+{input}')).toBe('+');
  });

  test('multi-char custom separator is derived verbatim', () => {
    expect(
      deriveWorktreeMarker('~/src/{repo}@{owner}', '~/src/{repo}@{owner}--wt--{input}'),
    ).toBe('--wt--');
  });

  test('absent worktreeTemplate falls back to the documented + default', () => {
    expect(deriveWorktreeMarker('~/src/{repo}@{owner}', '')).toBe('+');
  });

  test('worktreeTemplate not sharing the clone prefix falls back to + default', () => {
    // Worktrees live in a different tree entirely; no same-dir marker applies.
    expect(deriveWorktreeMarker('~/src/{repo}@{owner}', '~/wt/{repo}-{input}')).toBe('+');
  });

  test('worktreeTemplate equal to cloneTemplate (no suffix) falls back to + default', () => {
    expect(deriveWorktreeMarker('~/src/{repo}@{owner}', '~/src/{repo}@{owner}')).toBe('+');
  });
});
