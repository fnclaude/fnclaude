import { describe, expect, test } from "bun:test";
import type { ClaudeEvent, FilterState, UserTurn, Visibility } from "./events.ts";

describe("events contract", () => {
  test("UserTurn shape is constructible", () => {
    const turn: UserTurn = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    };
    expect(turn.type).toBe("user");
    expect(turn.message.content[0].text).toBe("hello");
  });

  test("ClaudeEvent discriminator narrows correctly", () => {
    const evt: ClaudeEvent = {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "s",
      uuid: "u",
      result: "ok",
      num_turns: 1,
      duration_ms: 0,
      duration_api_ms: 0,
      total_cost_usd: 0,
    };
    if (evt.type === "result") {
      expect(evt.is_error).toBe(false);
    }
  });

  test("FilterState accepts preset + overrides", () => {
    const state: FilterState = {
      preset: "normal",
      overrides: { "Bash.output": "show" },
    };
    const visibility: Visibility = state.overrides["Bash.output"] ?? "hide";
    expect(visibility).toBe("show");
  });
});
