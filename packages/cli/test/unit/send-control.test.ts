/**
 * Unit tests for the tagged control-injection seam (#299).
 *
 * `sendControl(kind, text)` is the dedicated path control traffic (context
 * notices, `/compact`, follow-up handoffs) routes through instead of the raw
 * keystroke injector `injectSubmittedLine`. It carries a STRUCTURAL marker
 * (the `kind` field) end-to-end so the renderer-side filter (#288) can
 * classify + hide control messages without string-sniffing the body — and so
 * the marker can't be spoofed by a user typing the same body text.
 *
 * The PTY seam additionally guards against splicing a control message into a
 * line the user is mid-typing: while a draft is in flight, control messages
 * are deferred and flushed once the user submits or clears the line.
 */

import { describe, expect, test } from 'bun:test';

import { injectSubmittedLine, type PtyWriter } from '../../src/mcp/handlers/inject-slash';
import {
  type ControlEnvelope,
  createControlSeamHolder,
  createPtyControlSeam,
  createRendererControlSeam,
} from '../../src/mcp/handlers/send-control';

/** Synchronous schedule so the separate CR write lands deterministically. */
const syncSchedule = (fn: () => void): void => fn();

/** The two writes injectSubmittedLine produces for one submitted line. */
function submitWrites(body: string): string[] {
  return [`\x1b[200~${body}\x1b[201~`, '\r'];
}

describe('structural marker — the seam carries a kind the raw injector cannot', () => {
  test('sendControl delivers (kind, text); injectSubmittedLine delivers only bytes', () => {
    // The body deliberately does NOT contain the kind word, so the only way to
    // recover "this is a compact control message" is the structural field.
    const body = 'hello world';

    const received: ControlEnvelope[] = [];
    const seam = createRendererControlSeam({
      sendControl: (kind, text) => received.push({ kind, text }),
    });
    seam('compact', body);

    expect(received).toEqual([{ kind: 'compact', text: body }]);
    // The marker is present and machine-detectable on the envelope.
    expect(received[0]!.kind).toBe('compact');

    // The raw keystroke path carries no kind — only the body bytes. There is
    // nothing in the emitted bytes from which "compact" could be recovered.
    const bytes: string[] = [];
    injectSubmittedLine(body, { write: (p) => bytes.push(p), schedule: syncSchedule });
    expect(bytes.join('').includes('compact')).toBe(false);
  });
});

describe('PTY seam — does not splice into in-flight user input', () => {
  test('a control message arriving mid-draft is deferred, not interleaved', () => {
    const writes: string[] = [];
    const seam = createPtyControlSeam({ write: (p) => writes.push(p), schedule: syncSchedule });

    // User is mid-typing a prompt.
    seam.noteUserInput('hel');
    seam.noteUserInput('lo');

    // A context notice fires WHILE the draft is non-empty. It must NOT write
    // into the terminal (that would splice into the user's partial line).
    seam.sendControl('notice', '<fnc-notice>compact soon</fnc-notice>');
    expect(writes).toEqual([]);

    // The user submits their line.
    seam.noteUserInput('\r');

    // Now the deferred control flushes as its own clean submit.
    expect(writes).toEqual(submitWrites('<fnc-notice>compact soon</fnc-notice>'));
  });

  test('with no draft in flight, control injects immediately (behavior unchanged)', () => {
    const writes: string[] = [];
    const seam = createPtyControlSeam({ write: (p) => writes.push(p), schedule: syncSchedule });

    seam.sendControl('notice', 'X');
    expect(writes).toEqual(submitWrites('X'));
  });

  test('a line-clear (Ctrl-U) also releases deferred control', () => {
    const writes: string[] = [];
    const seam = createPtyControlSeam({ write: (p) => writes.push(p), schedule: syncSchedule });

    seam.noteUserInput('half-typed');
    seam.sendControl('compact', '/compact');
    expect(writes).toEqual([]);

    seam.noteUserInput('\x15'); // kill line
    expect(writes).toEqual(submitWrites('/compact'));
  });

  test('multiple deferred messages flush in order on submit', () => {
    const writes: string[] = [];
    const seam = createPtyControlSeam({ write: (p) => writes.push(p), schedule: syncSchedule });

    seam.noteUserInput('typing');
    seam.sendControl('notice', 'A');
    seam.sendControl('followup', 'B');
    expect(writes).toEqual([]);

    seam.noteUserInput('\r');
    expect(writes).toEqual([...submitWrites('A'), ...submitWrites('B')]);
  });
});

describe('PTY seam — soft newlines do not read as submit', () => {
  // claude's multi-line input keys emit CR/LF WITHOUT submitting the prompt:
  // Ctrl-J (`\n`), Alt-Enter (`ESC`+`\r`), and backslash-continuation
  // (`\`+`\r`). A control notice flushed on any of these splices into the
  // still-open draft. Only a bare Enter (`\r`), Ctrl-C, or Ctrl-U really ends
  // the line, so only those may release deferred control.

  test('Ctrl-J (\\n) is a soft newline: deferred control stays queued', () => {
    const writes: string[] = [];
    const seam = createPtyControlSeam({ write: (p) => writes.push(p), schedule: syncSchedule });

    seam.noteUserInput('first line');
    seam.sendControl('notice', '<fnc-notice>compact soon</fnc-notice>');
    expect(writes).toEqual([]);

    // Ctrl-J adds a newline inside the multi-line prompt — it does NOT submit.
    seam.noteUserInput('\n');
    expect(writes).toEqual([]);
  });

  test('backslash-Enter across two chunks stays queued', () => {
    const writes: string[] = [];
    const seam = createPtyControlSeam({ write: (p) => writes.push(p), schedule: syncSchedule });

    seam.noteUserInput('first line');
    seam.sendControl('notice', 'N');
    expect(writes).toEqual([]);

    // `\` then `\r` arrive as separate stdin chunks — the preceding-byte check
    // must span chunk boundaries to recognise the continuation.
    seam.noteUserInput('\\');
    seam.noteUserInput('\r');
    expect(writes).toEqual([]);
  });

  test('Alt-Enter (ESC + CR) in one chunk stays queued', () => {
    const writes: string[] = [];
    const seam = createPtyControlSeam({ write: (p) => writes.push(p), schedule: syncSchedule });

    seam.noteUserInput('first line');
    seam.sendControl('notice', 'N');
    expect(writes).toEqual([]);

    seam.noteUserInput('\x1b\r');
    expect(writes).toEqual([]);
  });

  test('bare Enter (\\r) still submits and releases deferred control', () => {
    const writes: string[] = [];
    const seam = createPtyControlSeam({ write: (p) => writes.push(p), schedule: syncSchedule });

    seam.noteUserInput('first line');
    seam.sendControl('notice', 'N');
    expect(writes).toEqual([]);

    seam.noteUserInput('\r');
    expect(writes).toEqual(submitWrites('N'));
  });

  test('Unix multi-line paste keeps the draft: notice stays queued', () => {
    const writes: string[] = [];
    const seam = createPtyControlSeam({ write: (p) => writes.push(p), schedule: syncSchedule });

    // A bracketed paste with embedded `\n`s must not read as a submit.
    seam.noteUserInput('\x1b[200~a\nb\x1b[201~');
    seam.sendControl('notice', 'N');
    expect(writes).toEqual([]);
  });
});

describe('renderer seam — routes through the mount API, degrades gracefully', () => {
  test('prefers handle.sendControl, delivering the kind structurally', () => {
    const calls: ControlEnvelope[] = [];
    const seam = createRendererControlSeam({
      sendControl: (kind, text) => calls.push({ kind, text }),
      sendUserTurn: () => {
        throw new Error('sendUserTurn must not be used when sendControl exists');
      },
    });
    seam('followup', '@/tmp/x.md');
    expect(calls).toEqual([{ kind: 'followup', text: '@/tmp/x.md' }]);
  });

  test('falls back to sendUserTurn when an old handle lacks sendControl', () => {
    const turns: string[] = [];
    const seam = createRendererControlSeam({ sendUserTurn: (text) => turns.push(text) });
    seam('notice', '<fnc-notice>hi</fnc-notice>');
    expect(turns).toEqual(['<fnc-notice>hi</fnc-notice>']);
  });

  test('no-ops safely when the handle exposes neither method', () => {
    const seam = createRendererControlSeam({});
    expect(() => seam('compact', '/compact')).not.toThrow();
  });
});

describe('control seam holder — deferred binding queues then flushes', () => {
  test('messages sent before bind are queued and replayed on bind, in order', () => {
    const holder = createControlSeamHolder();
    expect(holder.isBound()).toBe(false);

    holder.sendControl('notice', 'A');
    holder.sendControl('compact', 'B');

    const delivered: ControlEnvelope[] = [];
    holder.bind((kind, text) => delivered.push({ kind, text }));

    expect(holder.isBound()).toBe(true);
    expect(delivered).toEqual([
      { kind: 'notice', text: 'A' },
      { kind: 'compact', text: 'B' },
    ]);
  });

  test('after bind, messages route straight through', () => {
    const holder = createControlSeamHolder();
    const delivered: ControlEnvelope[] = [];
    holder.bind((kind, text) => delivered.push({ kind, text }));
    holder.sendControl('followup', 'later');
    expect(delivered).toEqual([{ kind: 'followup', text: 'later' }]);
  });
});
