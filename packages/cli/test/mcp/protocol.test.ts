import { describe, expect, test } from 'bun:test';
import { Readable } from 'node:stream';
import {
  ActionDone,
  ActionError,
  ActionPasteFlow,
  decodeRequest,
  decodeResponse,
  encodeRequest,
  encodeResponse,
  OpCopy,
  OpRestart,
  OpSpawn,
  OpSwitch,
  readRequest,
  readResponse,
  type Request,
  type Response,
} from '../../src/mcp/protocol.js';

// ── Op / Action constants are byte-identical to Go ─────────────────────────

describe('Op / Action constants', () => {
  test('Op string values match Go wire format', () => {
    expect(OpRestart).toBe('restart');
    expect(OpSwitch).toBe('switch');
    expect(OpSpawn).toBe('spawn');
    expect(OpCopy).toBe('copy_to_clipboard');
  });

  test('Action string values match Go wire format', () => {
    expect(ActionDone).toBe('done');
    expect(ActionPasteFlow).toBe('paste_flow');
    expect(ActionError).toBe('error');
  });
});

// ── encode / decode round-trip ─────────────────────────────────────────────

describe('encode/decode round-trip', () => {
  test('Request round-trip preserves all fields', () => {
    const req: Request = {
      op: OpRestart,
      session_id: '01234567-89ab-cdef-0123-456789abcdef',
      model: 'sonnet',
      effort: 'high',
      permission_mode: 'plan',
      allowed_tools: 'Bash,Read',
      agent: 'foo',
      brief: true,
      chrome: false,
      ide: true,
      verbose: false,
    };
    const wire = encodeRequest(req).toString('utf8');
    expect(wire.endsWith('\n')).toBe(true);
    const back = decodeRequest(wire);
    expect(back).toEqual(req);
  });

  test('Response round-trip preserves all fields', () => {
    const resp: Response = {
      action: ActionPasteFlow,
      message: 'paste this',
      command: 'fnclaude foo --name bar',
      clipboard_ok: true,
    };
    const back = decodeResponse(encodeResponse(resp));
    expect(back).toEqual(resp);
  });

  test('encoded Request is a single newline-terminated JSON line', () => {
    const wire = encodeRequest({ op: OpSwitch, destination: 'x', name: 'y', summary: 'z' });
    const s = wire.toString('utf8');
    expect(s.endsWith('\n')).toBe(true);
    expect(s.slice(0, -1).includes('\n')).toBe(false);
    const obj = JSON.parse(s) as Request;
    expect(obj.op).toBe('switch');
  });
});

// ── decode tolerates trailing newline absence ──────────────────────────────

describe('decode tolerates with/without trailing newline', () => {
  test('Request decode without trailing newline', () => {
    const text = '{"op":"restart","session_id":"abc"}';
    expect(decodeRequest(text)).toEqual({
      op: OpRestart,
      session_id: 'abc',
    });
  });

  test('Request decode with trailing newline', () => {
    const text = '{"op":"restart","session_id":"abc"}\n';
    expect(decodeRequest(text)).toEqual({
      op: OpRestart,
      session_id: 'abc',
    });
  });

  test('Response decode from Buffer', () => {
    const buf = Buffer.from('{"action":"done"}\n', 'utf8');
    expect(decodeResponse(buf)).toEqual({ action: ActionDone });
  });
});

// ── decode rejects malformed JSON ──────────────────────────────────────────

describe('decode rejects malformed JSON', () => {
  test('decodeRequest throws on garbage', () => {
    expect(() => decodeRequest('not-json')).toThrow();
  });

  test('decodeResponse throws on garbage', () => {
    expect(() => decodeResponse('not-json')).toThrow();
  });
});

// ── decodeRequest input validation ─────────────────────────────────────────
//
// The wire format trusts whatever a connected client sends — the parent
// listener will dispatch and act on it. A compromised fnclaude-mcp
// subprocess (or anything else that learns the socket path) can submit
// arbitrary JSON. Validate shape, length, and dangerous bytes at the
// boundary so malformed input can't reach the dispatcher's
// re-exec / clipboard / file-write paths.

describe('decodeRequest validation rejects malformed payloads', () => {
  test('non-object payload', () => {
    expect(() => decodeRequest('"just-a-string"')).toThrow(/object/i);
    expect(() => decodeRequest('null')).toThrow(/object/i);
    expect(() => decodeRequest('42')).toThrow(/object/i);
    expect(() => decodeRequest('[]')).toThrow(/object/i);
  });

  test('missing or unknown op', () => {
    expect(() => decodeRequest('{}')).toThrow(/op/i);
    expect(() => decodeRequest('{"op":"explode"}')).toThrow(/op/i);
    expect(() => decodeRequest('{"op":42}')).toThrow(/op/i);
  });

  test('wrong type for a string field', () => {
    expect(() =>
      decodeRequest(JSON.stringify({ op: 'restart', session_id: 42 })),
    ).toThrow(/session_id/i);
    expect(() =>
      decodeRequest(JSON.stringify({ op: 'switch', destination: { evil: true } })),
    ).toThrow(/destination/i);
  });

  test('wrong type for a boolean override field', () => {
    expect(() =>
      decodeRequest(JSON.stringify({ op: 'restart', session_id: 'abc', brief: 'yes' })),
    ).toThrow(/brief/i);
  });

  test('null byte in any string field is rejected', () => {
    expect(() =>
      decodeRequest(JSON.stringify({ op: 'restart', session_id: 'abc\x00def' })),
    ).toThrow(/null byte/i);
    expect(() =>
      decodeRequest(JSON.stringify({ op: 'copy_to_clipboard', text: 'safe\x00bad' })),
    ).toThrow(/null byte/i);
  });

  test('parent-traversal segment in destination is rejected', () => {
    expect(() =>
      decodeRequest(JSON.stringify({ op: 'switch', destination: '../etc/passwd' })),
    ).toThrow(/destination|traversal/i);
    expect(() =>
      decodeRequest(JSON.stringify({ op: 'switch', destination: '/safe/../etc' })),
    ).toThrow(/destination|traversal/i);
    expect(() =>
      decodeRequest(JSON.stringify({ op: 'spawn', destination: 'foo/../bar' })),
    ).toThrow(/destination|traversal/i);
  });

  test('benign ".." substring (not a path segment) is allowed', () => {
    // ".." inside a path component like "foo..bar" or trailing ".." inside
    // a longer name MUST NOT be a false positive — only true segments
    // (delimited by / or string ends) are dangerous.
    const got = decodeRequest(
      JSON.stringify({ op: 'switch', destination: '/foo..bar/baz' }),
    );
    expect(got).toMatchObject({ op: 'switch', destination: '/foo..bar/baz' });
  });

  test('over-length string fields are rejected', () => {
    // Short fields like model / effort / permission_mode have a tight cap;
    // summary has a generous cap (it's the handoff continuity blob).
    const huge = 'a'.repeat(1024 * 1024); // 1 MiB
    expect(() =>
      decodeRequest(JSON.stringify({ op: 'restart', model: huge })),
    ).toThrow(/length|model/i);
    expect(() =>
      decodeRequest(JSON.stringify({ op: 'switch', destination: 'a'.repeat(10_000) })),
    ).toThrow(/length|destination/i);
  });

  test('valid restart payload passes through unchanged', () => {
    const req = decodeRequest(
      JSON.stringify({
        op: 'restart',
        session_id: '01234567-89ab-cdef-0123-456789abcdef',
        model: 'sonnet',
        brief: true,
      }),
    );
    expect(req).toEqual({
      op: 'restart',
      session_id: '01234567-89ab-cdef-0123-456789abcdef',
      model: 'sonnet',
      brief: true,
    });
  });
});

// ── readRequest / readResponse stream behavior ─────────────────────────────

describe('readRequest / readResponse over async iterable streams', () => {
  test('readRequest decodes one line from a single chunk', async () => {
    const wire = encodeRequest({ op: OpRestart, session_id: 'abc' });
    const stream = Readable.from([wire]);
    const got = await readRequest(stream);
    expect(got).toEqual({ op: OpRestart, session_id: 'abc' });
  });

  test('readRequest assembles across chunk boundaries', async () => {
    const wire = encodeRequest({ op: OpSwitch, destination: 'x', name: 'y' });
    const half = wire.length >>> 1;
    const chunks = [wire.subarray(0, half), wire.subarray(half)];
    const stream = Readable.from(chunks);
    const got = await readRequest(stream);
    expect(got).toEqual({ op: OpSwitch, destination: 'x', name: 'y' });
  });

  test('readResponse returns null on clean EOF', async () => {
    const stream = Readable.from([] as Buffer[]);
    const got = await readResponse(stream);
    expect(got).toBeNull();
  });

  test('readRequest stops at first newline (one line per connection)', async () => {
    const a = encodeRequest({ op: OpCopy, text: 'first' });
    const b = encodeRequest({ op: OpCopy, text: 'second' });
    const stream = Readable.from([Buffer.concat([a, b])]);
    const got = await readRequest(stream);
    expect(got).toEqual({ op: OpCopy, text: 'first' });
  });
});
