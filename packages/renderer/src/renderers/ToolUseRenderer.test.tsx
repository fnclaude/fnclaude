import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { ToolUseBlock, Visibility } from "../types/events";
import { ToolUseRenderer } from "./ToolUseRenderer";

const visAll = (v: Visibility) => () => v;

describe("ToolUseRenderer", () => {
  test("dispatches Bash → BashInput", () => {
    const block: ToolUseBlock = {
      type: "tool_use",
      id: "tu1",
      name: "Bash",
      input: { command: "ls -la", description: "list files" },
    };
    const { lastFrame } = render(<ToolUseRenderer block={block} visibilityFor={visAll("show")} />);
    expect(lastFrame() ?? "").toContain("ls -la");
  });

  test("dispatches Edit → EditDiff", () => {
    const block: ToolUseBlock = {
      type: "tool_use",
      id: "tu2",
      name: "Edit",
      input: { file_path: "/x.txt", old_string: "a", new_string: "b" },
    };
    const { lastFrame } = render(<ToolUseRenderer block={block} visibilityFor={visAll("show")} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("/x.txt");
    expect(frame).toContain("- a");
    expect(frame).toContain("+ b");
  });

  test("dispatches Read → ReadInput (path always shown)", () => {
    const block: ToolUseBlock = {
      type: "tool_use",
      id: "tu3",
      name: "Read",
      input: { file_path: "/etc/hosts" },
    };
    const { lastFrame } = render(<ToolUseRenderer block={block} visibilityFor={visAll("hide")} />);
    expect(lastFrame() ?? "").toContain("/etc/hosts");
  });

  test("dispatches Write → WriteContent", () => {
    const block: ToolUseBlock = {
      type: "tool_use",
      id: "tu4",
      name: "Write",
      input: { file_path: "/o.txt", content: "hello world" },
    };
    const { lastFrame } = render(<ToolUseRenderer block={block} visibilityFor={visAll("show")} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("/o.txt");
    expect(frame).toContain("hello world");
  });

  test("dispatches Task → TaskNested", () => {
    const block: ToolUseBlock = {
      type: "tool_use",
      id: "tu5",
      name: "Task",
      input: { description: "do thing", prompt: "do the thing" },
    };
    const { lastFrame } = render(<ToolUseRenderer block={block} visibilityFor={visAll("show")} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Task");
    expect(frame).toContain("do the thing");
  });

  test("unknown tool → generic fallback with tool name and input summary", () => {
    const block: ToolUseBlock = {
      type: "tool_use",
      id: "tu6",
      name: "Glob",
      input: { pattern: "**/*.ts" },
    };
    const { lastFrame } = render(<ToolUseRenderer block={block} visibilityFor={visAll("show")} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Glob");
    expect(frame).toContain("**/*.ts");
  });

  test("unknown tool_use → structured key/value, not raw JSON", () => {
    const block: ToolUseBlock = {
      type: "tool_use",
      id: "tu8",
      name: "Glob",
      input: { pattern: "**/*.ts", path: "/src" },
    };
    const { lastFrame } = render(<ToolUseRenderer block={block} visibilityFor={visAll("show")} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Glob");
    // key/value rows, keys dimmed with a trailing colon
    expect(frame).toContain("pattern:");
    expect(frame).toContain("**/*.ts");
    // NOT raw JSON: no quoted keys, no braces, no {name,input} wrapper
    expect(frame).not.toContain('"pattern"');
    expect(frame).not.toContain("{");
    expect(frame).not.toContain("}");
    expect(frame).not.toContain('"name"');
  });

  test("unknown tool_use under summary → one-line salient arg", () => {
    const block: ToolUseBlock = {
      type: "tool_use",
      id: "tu9",
      name: "Glob",
      input: { pattern: "**/*.ts", path: "/src" },
    };
    const { lastFrame } = render(
      <ToolUseRenderer block={block} visibilityFor={visAll("summary")} />,
    );
    const frame = (lastFrame() ?? "").trim();
    expect(frame).toContain("Glob");
    expect(frame).toContain("**/*.ts");
    // one line only — the non-salient arg is not shown
    expect(frame.split("\n").length).toBe(1);
    expect(frame).not.toContain("/src");
  });

  test("unknown tool_use consults the shared tool.generic element id", () => {
    const queriedIds: string[] = [];
    const visFor = (id: string) => {
      queriedIds.push(id);
      return "show" as const;
    };
    const block: ToolUseBlock = {
      type: "tool_use",
      id: "tu10",
      name: "WebFetch",
      input: { url: "https://example.com" },
    };
    render(<ToolUseRenderer block={block} visibilityFor={visFor} />);
    expect(queriedIds).toContain("tool.generic");
  });

  test("visibilityFor is consulted per element id", () => {
    const queriedIds: string[] = [];
    const visFor = (id: string) => {
      queriedIds.push(id);
      return "hide" as const;
    };
    const block: ToolUseBlock = {
      type: "tool_use",
      id: "tu7",
      name: "Bash",
      input: { command: "rm -rf /" },
    };
    render(<ToolUseRenderer block={block} visibilityFor={visFor} />);
    expect(queriedIds).toContain("Bash.input");
  });
});
