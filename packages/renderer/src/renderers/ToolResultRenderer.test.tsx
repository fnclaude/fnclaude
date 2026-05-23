import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { ToolResultBlock, Visibility } from "../types/events.ts";
import { ToolResultRenderer } from "./ToolResultRenderer.tsx";

const visAll = (v: Visibility) => () => v;

describe("ToolResultRenderer", () => {
  test("Bash result → BashOutput with Bash.output visibility", () => {
    const block: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: "tu1",
      content: "stdout line",
    };
    const { lastFrame } = render(
      <ToolResultRenderer block={block} toolName="Bash" visibilityFor={visAll("show")} />,
    );
    expect(lastFrame() ?? "").toContain("stdout line");
  });

  test("Read result → ReadContent with Read.content visibility", () => {
    const body = "file body line 1\nfile body line 2";
    const block: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: "tu2",
      content: body,
    };
    const { lastFrame } = render(
      <ToolResultRenderer
        block={block}
        toolName="Read"
        toolInput={{ file_path: "/etc/hosts" }}
        visibilityFor={visAll("summary")}
      />,
    );
    const frame = lastFrame() ?? "";
    // summary mode: path + line count, no body
    expect(frame).toContain("/etc/hosts");
    expect(frame).toMatch(/2 lines/);
    expect(frame).not.toContain("file body line 1");
  });

  test("is_error: delegates to ErrorRenderer (red)", () => {
    const block: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: "tuX",
      content: "permission denied",
      is_error: true,
    };
    const { lastFrame } = render(
      <ToolResultRenderer block={block} toolName="Bash" visibilityFor={visAll("show")} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("permission denied");
    expect(frame).toMatch(/\x1B\[31m/);
  });

  test("accepts content as TextBlock[]", () => {
    const block: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: "tu3",
      content: [
        { type: "text", text: "part1" },
        { type: "text", text: "part2" },
      ],
    };
    const { lastFrame } = render(
      <ToolResultRenderer block={block} toolName="Bash" visibilityFor={visAll("show")} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("part1");
    expect(frame).toContain("part2");
  });

  test("unknown tool result → generic text block", () => {
    const block: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: "tu4",
      content: "some glob output",
    };
    const { lastFrame } = render(
      <ToolResultRenderer block={block} toolName="Glob" visibilityFor={visAll("show")} />,
    );
    expect(lastFrame() ?? "").toContain("some glob output");
  });

  test("Bash output hide vs show differ", () => {
    const block: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: "tu5",
      content: "interesting output",
    };
    const a =
      render(
        <ToolResultRenderer block={block} toolName="Bash" visibilityFor={visAll("show")} />,
      ).lastFrame() ?? "";
    const b =
      render(
        <ToolResultRenderer block={block} toolName="Bash" visibilityFor={visAll("hide")} />,
      ).lastFrame() ?? "";
    expect(a).not.toBe(b);
    expect(a).toContain("interesting output");
    expect(b).not.toContain("interesting output");
  });
});
