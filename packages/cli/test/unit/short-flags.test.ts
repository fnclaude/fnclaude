import { describe, expect, test } from 'bun:test';

import { expandShortFlags } from '../../src/argv/short-flags';

function ok(input: string[], expected: string[]) {
  const r = expandShortFlags(input);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.tokens).toEqual(expected);
}

function err(input: string[], match: RegExp) {
  const r = expandShortFlags(input);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(match);
}

describe('expandShortFlags — shortNoValue (B,C,D,F,I,V)', () => {
  test('-B → --brief', () => ok(['-B'], ['--brief']));
  test('-C → --chrome', () => ok(['-C'], ['--chrome']));
  test('-D → --dangerously-skip-permissions', () => ok(['-D'], ['--dangerously-skip-permissions']));
  test('-F → --fork-session', () => ok(['-F'], ['--fork-session']));
  test('-I → --ide', () => ok(['-I'], ['--ide']));
  test('-V → --verbose', () => ok(['-V'], ['--verbose']));
});

describe('expandShortFlags — clusters of shortNoValue', () => {
  test('-BV → --brief --verbose', () => ok(['-BV'], ['--brief', '--verbose']));
  test('-BVC → --brief --verbose --chrome', () =>
    ok(['-BVC'], ['--brief', '--verbose', '--chrome']));
  test('all six together → all expanded in order', () =>
    ok(
      ['-BCDFIV'],
      ['--brief', '--chrome', '--dangerously-skip-permissions', '--fork-session', '--ide', '--verbose'],
    ));
});

describe('expandShortFlags — shortRequired (G,M,W)', () => {
  test('-M plan → --permission-mode plan', () =>
    ok(['-M', 'plan'], ['--permission-mode', 'plan']));
  test('-G agent-name → --agent agent-name', () =>
    ok(['-G', 'my-agent'], ['--agent', 'my-agent']));
  test('-W tool-list → --allowedTools tool-list', () =>
    ok(['-W', 'Bash,Read'], ['--allowedTools', 'Bash,Read']));

  test('-M=plan → --permission-mode=plan (single-token equals form)', () =>
    ok(['-M=plan'], ['--permission-mode=plan']));
  test('-G=agent → --agent=agent', () => ok(['-G=agent'], ['--agent=agent']));

  test('-M at end of cluster: consumes next token', () =>
    ok(['-BCM', 'plan'], ['--brief', '--chrome', '--permission-mode', 'plan']));

  test('-M in middle of cluster → error', () => err(['-MV'], /-M.*middle|middle.*-M/));
  test('-WB in middle → error', () => err(['-WB'], /-W.*middle|middle.*-W/));

  test('-M without next token → error', () => err(['-M'], /-M requires a value/));
  test('-M followed by -other (looks like flag) → error', () =>
    err(['-M', '-other'], /-M requires a value/));
});

describe('expandShortFlags — shortOptional (P,R,T)', () => {
  test('-T alone → --tmux (no value)', () => ok(['-T'], ['--tmux']));
  test('-T followed by non-flag → consumed greedily', () =>
    ok(['-T', 'session-name'], ['--tmux', 'session-name']));
  test('-T followed by -flag → not consumed; --tmux alone', () =>
    ok(['-T', '-V'], ['--tmux', '--verbose']));
  test('-P alone → --from-pr', () => ok(['-P'], ['--from-pr']));
  test('-R 123 → --remote-control 123', () =>
    ok(['-R', '123'], ['--remote-control', '123']));

  test('-T=session → --tmux=session', () => ok(['-T=session'], ['--tmux=session']));

  test('shortOptional in MIDDLE of cluster → emits flag without value', () =>
    ok(['-TV'], ['--tmux', '--verbose']));

  test('shortOptional at END consumes next non-flag', () =>
    ok(['-BT', 'sname'], ['--brief', '--tmux', 'sname']));
});

describe('expandShortFlags — unknown short flags pass through', () => {
  test('-h (lowercase, not in any table) → -h verbatim', () =>
    ok(['-h'], ['-h']));
  test('-x → -x verbatim', () => ok(['-x'], ['-x']));
  test('cluster with unknown: -Bh → --brief -h', () =>
    ok(['-Bh'], ['--brief', '-h']));
  test('all-unknown cluster: -hxy → -h -x -y', () =>
    ok(['-hxy'], ['-h', '-x', '-y']));
});

describe('expandShortFlags — sentinel stops expansion', () => {
  test('-B -- -V → --brief -- -V (do not expand after `--`)', () =>
    ok(['-B', '--', '-V'], ['--brief', '--', '-V']));
  test('cluster after sentinel kept verbatim', () =>
    ok(['--', '-BVCMpause'], ['--', '-BVCMpause']));
});

describe('expandShortFlags — pass-through edge cases', () => {
  test('bare `-` (stdin marker) preserved', () =>
    ok(['-'], ['-']));
  test('long flags preserved verbatim', () =>
    ok(['--verbose'], ['--verbose']));
  test('--long=value preserved verbatim', () =>
    ok(['--permission-mode=plan'], ['--permission-mode=plan']));
  test('empty input → empty output', () => ok([], []));
  test('positional-looking value (no leading dash) passes through', () =>
    ok(['hello'], ['hello']));
});

describe('expandShortFlags — mixed realistic case', () => {
  test('-BV --foo bar -M plan -- prompt body', () =>
    ok(
      ['-BV', '--foo', 'bar', '-M', 'plan', '--', 'prompt body'],
      ['--brief', '--verbose', '--foo', 'bar', '--permission-mode', 'plan', '--', 'prompt body'],
    ));
});
