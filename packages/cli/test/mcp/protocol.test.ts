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
