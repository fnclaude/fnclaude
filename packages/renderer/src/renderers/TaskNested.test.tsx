import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { TaskNested } from "./TaskNested.tsx";

const prompt = `Find all TypeScript files.
Then count lines of code in each.
Report top 10 by size.
Include only .ts and .tsx.
Use ripgrep.
Output JSON.`;

describe("TaskNested", () => {
  test("show: full prompt rendered", () => {
    const { lastFrame } = render(
      <TaskNested description="audit ts" prompt={prompt} visibility="show" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Find all TypeScript");
    expect(frame).toContain("Output JSON");
  });

  test("hide: header only", () => {
    const { lastFrame } = render(
      <TaskNested description="audit ts" prompt={prompt} visibility="hide" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Task");
    expect(frame).toContain("audit ts");
    expect(frame).not.toContain("Find all TypeScript");
  });

  test("summary: first line + line count", () => {
    const { lastFrame } = render(
      <TaskNested description="audit ts" prompt={prompt} visibility="summary" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Find all TypeScript files.");
    expect(frame).toMatch(/6 lines/);
    expect(frame).not.toContain("Output JSON");
  });

  test("dim: full body with dim styling", () => {
    const { lastFrame } = render(<TaskNested description="t" prompt="hello" visibility="dim" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("hello");
    expect(frame).toMatch(/\x1B\[2m/);
  });

  test("show vs hide vs summary differ", () => {
    const p = { description: "d", prompt };
    const a = render(<TaskNested {...p} visibility="show" />).lastFrame() ?? "";
    const b = render(<TaskNested {...p} visibility="hide" />).lastFrame() ?? "";
    const c = render(<TaskNested {...p} visibility="summary" />).lastFrame() ?? "";
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });
});
