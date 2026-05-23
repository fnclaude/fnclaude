import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { EditDiff } from "./EditDiff.tsx";

const oldStr = "old line 1\nold line 2";
const newStr = "new line 1\nnew line 2\nnew line 3";

describe("EditDiff", () => {
  test("show: file path + diff body", () => {
    const { lastFrame } = render(
      <EditDiff filePath="/tmp/foo.txt" oldString={oldStr} newString={newStr} visibility="show" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("/tmp/foo.txt");
    expect(frame).toContain("old line 1");
    expect(frame).toContain("new line 1");
  });

  test("hide: header only, no diff body", () => {
    const { lastFrame } = render(
      <EditDiff filePath="/tmp/foo.txt" oldString={oldStr} newString={newStr} visibility="hide" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("/tmp/foo.txt");
    expect(frame).not.toContain("old line 1");
    expect(frame).not.toContain("new line 1");
  });

  test("summary: file path + change line count, no diff body", () => {
    const { lastFrame } = render(
      <EditDiff
        filePath="/tmp/foo.txt"
        oldString={oldStr}
        newString={newStr}
        visibility="summary"
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("/tmp/foo.txt");
    // 2 lines removed + 3 lines added
    expect(frame).toMatch(/-2/);
    expect(frame).toMatch(/\+3/);
    expect(frame).not.toContain("old line 1");
    expect(frame).not.toContain("new line 1");
  });

  test("dim: full content with dim styling", () => {
    const { lastFrame } = render(
      <EditDiff filePath="/tmp/foo.txt" oldString={oldStr} newString={newStr} visibility="dim" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("/tmp/foo.txt");
    expect(frame).toMatch(/\x1B\[2m/);
  });

  test("show vs hide vs summary differ", () => {
    const p = { filePath: "/tmp/x", oldString: oldStr, newString: newStr };
    const a = render(<EditDiff {...p} visibility="show" />).lastFrame() ?? "";
    const b = render(<EditDiff {...p} visibility="hide" />).lastFrame() ?? "";
    const c = render(<EditDiff {...p} visibility="summary" />).lastFrame() ?? "";
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });
});
