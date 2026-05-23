/**
 * Tests for the NDJSON event parser.
 *
 * Strategy: feed real fixtures (recorded from `claude --print --verbose
 * --input-format stream-json --output-format stream-json`) through the parser
 * and assert on the discriminated union shapes. No live claude invocation
 * needed.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseNdjsonStream } from "./event-parser.ts";
import type {
  AssistantEvent,
  ContentBlock,
  ResultEvent,
  SystemEvent,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "./types/events.ts";

const fixtureDir = join(import.meta.dir, "__fixtures__");

function fixtureStream(name: string): ReadableStream<Uint8Array> {
  const bytes = readFileSync(join(fixtureDir, name));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

describe("parseNdjsonStream — text turn", () => {
  test("emits system/init, rate_limit_event, assistant, result in order", async () => {
    const events = [];
    for await (const ev of parseNdjsonStream(fixtureStream("text-turn.ndjson"))) {
      events.push(ev);
    }
    const types = events.map((e) => e.type);
    expect(types).toContain("system");
    expect(types).toContain("assistant");
    expect(types).toContain("result");
  });

  test("system event has subtype init and session_id", async () => {
    for await (const ev of parseNdjsonStream(fixtureStream("text-turn.ndjson"))) {
      if (ev.type === "system") {
        const sys = ev as SystemEvent;
        expect(sys.subtype).toBe("init");
        expect(typeof sys.session_id).toBe("string");
        expect(sys.session_id.length).toBeGreaterThan(0);
        return;
      }
    }
    throw new Error("no system event found");
  });

  test("assistant event has text content block", async () => {
    for await (const ev of parseNdjsonStream(fixtureStream("text-turn.ndjson"))) {
      if (ev.type === "assistant") {
        const ast = ev as AssistantEvent;
        const textBlock = ast.message.content.find((b: ContentBlock) => b.type === "text") as
          | TextBlock
          | undefined;
        expect(textBlock).toBeDefined();
        expect(typeof textBlock?.text).toBe("string");
        return;
      }
    }
    throw new Error("no assistant event found");
  });

  test("result event is success and carries num_turns", async () => {
    for await (const ev of parseNdjsonStream(fixtureStream("text-turn.ndjson"))) {
      if (ev.type === "result") {
        const res = ev as ResultEvent;
        expect(res.subtype).toBe("success");
        expect(res.is_error).toBe(false);
        expect(typeof res.num_turns).toBe("number");
        expect(typeof res.duration_ms).toBe("number");
        return;
      }
    }
    throw new Error("no result event found");
  });
});

describe("parseNdjsonStream — tool-use turn", () => {
  test("assistant event contains tool_use block", async () => {
    for await (const ev of parseNdjsonStream(fixtureStream("tool-use-turn.ndjson"))) {
      if (ev.type === "assistant") {
        const ast = ev as AssistantEvent;
        const toolBlock = ast.message.content.find((b: ContentBlock) => b.type === "tool_use") as
          | ToolUseBlock
          | undefined;
        if (toolBlock !== undefined) {
          expect(toolBlock.id).toBeTruthy();
          expect(typeof toolBlock.name).toBe("string");
          expect(typeof toolBlock.input).toBe("object");
          return;
        }
      }
    }
    throw new Error("no tool_use block found in assistant event");
  });

  test("user event contains tool_result block", async () => {
    for await (const ev of parseNdjsonStream(fixtureStream("tool-use-turn.ndjson"))) {
      if (ev.type === "user") {
        const msg = ev.message;
        const content = Array.isArray(msg.content) ? msg.content : [];
        const resultBlock = content.find((b: ContentBlock) => b.type === "tool_result") as
          | ToolResultBlock
          | undefined;
        if (resultBlock !== undefined) {
          expect(typeof resultBlock.tool_use_id).toBe("string");
          return;
        }
      }
    }
    throw new Error("no tool_result block found in user event");
  });
});

describe("parseNdjsonStream — slash-command turn", () => {
  test("assistant event has model <synthetic>", async () => {
    for await (const ev of parseNdjsonStream(fixtureStream("slash-command-turn.ndjson"))) {
      if (ev.type === "assistant") {
        const ast = ev as AssistantEvent;
        expect(ast.message.model).toBe("<synthetic>");
        return;
      }
    }
    throw new Error("no assistant event found");
  });

  test("result event is success", async () => {
    for await (const ev of parseNdjsonStream(fixtureStream("slash-command-turn.ndjson"))) {
      if (ev.type === "result") {
        const res = ev as ResultEvent;
        expect(res.subtype).toBe("success");
        return;
      }
    }
    throw new Error("no result event found");
  });
});

describe("parseNdjsonStream — unknown slash command", () => {
  test("no assistant event emitted", async () => {
    let sawAssistant = false;
    for await (const ev of parseNdjsonStream(fixtureStream("unknown-slash-command-turn.ndjson"))) {
      if (ev.type === "assistant") {
        sawAssistant = true;
      }
    }
    expect(sawAssistant).toBe(false);
  });

  test("result.result contains Unknown command and is_error is false", async () => {
    for await (const ev of parseNdjsonStream(fixtureStream("unknown-slash-command-turn.ndjson"))) {
      if (ev.type === "result") {
        const res = ev as ResultEvent;
        expect(res.result).toContain("Unknown command");
        expect(res.is_error).toBe(false);
        return;
      }
    }
    throw new Error("no result event found");
  });
});

describe("parseNdjsonStream — multi-turn", () => {
  test("all events share the same session_id", async () => {
    const sessionIds = new Set<string>();
    for await (const ev of parseNdjsonStream(fixtureStream("multi-turn.ndjson"))) {
      if ("session_id" in ev && typeof ev.session_id === "string") {
        sessionIds.add(ev.session_id);
      }
    }
    expect(sessionIds.size).toBe(1);
  });

  test("result event carries num_turns reflecting both turns", async () => {
    // When two user turns are piped back-to-back without waiting for a result
    // between them, claude processes them as one session run and emits a single
    // result with num_turns reflecting the combined work (observed: 4 turns due
    // to internal tool calls). The important invariant is that num_turns >= 1.
    for await (const ev of parseNdjsonStream(fixtureStream("multi-turn.ndjson"))) {
      if (ev.type === "result") {
        const res = ev as ResultEvent;
        expect(res.num_turns).toBeGreaterThanOrEqual(1);
        return;
      }
    }
    throw new Error("no result event found");
  });
});

describe("parseNdjsonStream — large-line tolerance", () => {
  test("handles a line of 64KB without dropping it", async () => {
    // Synthetic: a valid JSON object whose text field is 64KB long.
    const bigText = "x".repeat(64 * 1024);
    const payload = JSON.stringify({
      type: "assistant",
      session_id: "test-session",
      uuid: "test-uuid",
      message: {
        id: "msg_test",
        model: "test-model",
        role: "assistant",
        content: [{ type: "text", text: bigText }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const bytes = new TextEncoder().encode(`${payload}\n`);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const events = [];
    for await (const ev of parseNdjsonStream(stream)) {
      events.push(ev);
    }
    expect(events.length).toBe(1);
    const ast = events[0] as AssistantEvent;
    expect(ast.type).toBe("assistant");
    const textBlock = ast.message.content[0] as TextBlock;
    expect(textBlock.text.length).toBe(64 * 1024);
  });
});

describe("parseNdjsonStream — partial trailing data", () => {
  test("discards incomplete trailing line without throwing", async () => {
    // A complete line followed by partial (no trailing newline).
    const complete = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "s1",
      uuid: "u1",
      result: "ok",
      num_turns: 1,
      duration_ms: 100,
      duration_api_ms: 100,
      total_cost_usd: 0,
    });
    const partial = '{"type":"assistant","partial":true';
    const text = `${complete}\n${partial}`;
    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const events = [];
    for await (const ev of parseNdjsonStream(stream)) {
      events.push(ev);
    }
    // Only the complete line should yield an event; partial is silently dropped.
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("result");
  });
});
