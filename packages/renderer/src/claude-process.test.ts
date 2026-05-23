/**
 * Tests for the claude subprocess driver.
 *
 * Strategy: inject a mock spawn function rather than invoking the real claude
 * binary. This makes the tests hermetic and fast — no network calls, no
 * dependency on a live claude installation, and safe to run in CI where the
 * binary may not be present or authenticated.
 *
 * The mock spawn writes a real fixture file's bytes to a fake stdout pipe
 * (ReadableStream), then closes it, simulating what claude would emit. The
 * driver reads from that stream via the parser. We also test that
 * sendUserTurn serialises the UserTurn shape correctly by inspecting what
 * was written to the mock stdin.
 *
 * The mock surface: `subscribeToClaude` accepts an optional `spawnFn`
 * parameter of type `SpawnFn`. Callers that omit it get the real
 * `Bun.spawn`-backed implementation; test code passes a mock.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SpawnFn } from "./claude-process.ts";
import { subscribeToClaude } from "./claude-process.ts";
import type { AssistantEvent, ResultEvent, SystemEvent } from "./types/events.ts";

const fixtureDir = join(import.meta.dir, "__fixtures__");

function makeFixtureSpawn(fixtureName: string): {
  spawnFn: SpawnFn;
  getStdinWrites: () => string[];
} {
  const stdinWrites: string[] = [];

  const spawnFn: SpawnFn = (_cmd, _opts) => {
    const fixtureBytes = readFileSync(join(fixtureDir, fixtureName));

    // Fake stdout: a ReadableStream that immediately emits the fixture.
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(fixtureBytes));
        controller.close();
      },
    });

    // Fake stdin: a WritableStream that records written strings.
    const stdin = new WritableStream<Uint8Array>({
      write(chunk) {
        stdinWrites.push(new TextDecoder().decode(chunk));
      },
    });

    return {
      stdout,
      stdin,
      exited: Promise.resolve(0),
      kill: () => undefined,
    };
  };

  return { spawnFn, getStdinWrites: () => stdinWrites };
}

describe("subscribeToClaude — text turn", () => {
  test("yields system, assistant, result events from fixture", async () => {
    const { spawnFn } = makeFixtureSpawn("text-turn.ndjson");
    const { events } = subscribeToClaude({ spawnFn });

    const collected = [];
    for await (const ev of events) {
      collected.push(ev);
    }

    const types = collected.map((e) => e.type);
    expect(types).toContain("system");
    expect(types).toContain("assistant");
    expect(types).toContain("result");
  });

  test("system event has session_id and subtype init", async () => {
    const { spawnFn } = makeFixtureSpawn("text-turn.ndjson");
    const { events } = subscribeToClaude({ spawnFn });

    for await (const ev of events) {
      if (ev.type === "system") {
        const sys = ev as SystemEvent;
        expect(sys.subtype).toBe("init");
        expect(typeof sys.session_id).toBe("string");
        return;
      }
    }
    throw new Error("no system event");
  });

  test("result event is success", async () => {
    const { spawnFn } = makeFixtureSpawn("text-turn.ndjson");
    const { events } = subscribeToClaude({ spawnFn });

    for await (const ev of events) {
      if (ev.type === "result") {
        const res = ev as ResultEvent;
        expect(res.subtype).toBe("success");
        expect(res.is_error).toBe(false);
        return;
      }
    }
    throw new Error("no result event");
  });
});

describe("subscribeToClaude — sendUserTurn", () => {
  test("sendUserTurn writes valid UserTurn JSON followed by newline", async () => {
    const { spawnFn, getStdinWrites } = makeFixtureSpawn("text-turn.ndjson");
    const { events, sendUserTurn } = subscribeToClaude({ spawnFn });

    sendUserTurn("hello world");

    // Drain events so the mock finishes.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ev of events) {
      /* drain */
    }

    const writes = getStdinWrites();
    expect(writes.length).toBeGreaterThan(0);
    const allWritten = writes.join("");
    // Must end with a newline.
    expect(allWritten.endsWith("\n")).toBe(true);
    // Must parse as valid JSON.
    const parsed = JSON.parse(allWritten.trim()) as Record<string, unknown>;
    expect(parsed.type).toBe("user");
    const msg = parsed.message as Record<string, unknown>;
    expect(msg.role).toBe("user");
    const content = msg.content as Array<Record<string, unknown>>;
    expect(content[0]?.type).toBe("text");
    expect(content[0]?.text).toBe("hello world");
  });
});

describe("subscribeToClaude — close", () => {
  test("close() resolves and process exits cleanly", async () => {
    const { spawnFn } = makeFixtureSpawn("text-turn.ndjson");
    const { events, close } = subscribeToClaude({ spawnFn });

    // Drain so we know the mock stream closed.
    for await (const _ev of events) {
      /* drain */
    }

    const exitCode = await close();
    expect(exitCode).toBe(0);
  });
});

describe("subscribeToClaude — tool-use fixture", () => {
  test("emits assistant with tool_use and user with tool_result", async () => {
    const { spawnFn } = makeFixtureSpawn("tool-use-turn.ndjson");
    const { events } = subscribeToClaude({ spawnFn });

    let sawToolUse = false;
    let sawToolResult = false;

    for await (const ev of events) {
      if (ev.type === "assistant") {
        const ast = ev as AssistantEvent;
        for (const block of ast.message.content) {
          if (block.type === "tool_use") sawToolUse = true;
        }
      }
      if (ev.type === "user") {
        const content = Array.isArray(ev.message.content) ? ev.message.content : [];
        for (const block of content) {
          if (block.type === "tool_result") sawToolResult = true;
        }
      }
    }

    expect(sawToolUse).toBe(true);
    expect(sawToolResult).toBe(true);
  });
});

describe("subscribeToClaude — slash command fixture", () => {
  test("assistant model is <synthetic>", async () => {
    const { spawnFn } = makeFixtureSpawn("slash-command-turn.ndjson");
    const { events } = subscribeToClaude({ spawnFn });

    for await (const ev of events) {
      if (ev.type === "assistant") {
        const ast = ev as AssistantEvent;
        expect(ast.message.model).toBe("<synthetic>");
        return;
      }
    }
    throw new Error("no assistant event");
  });
});
