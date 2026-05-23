import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { BashInput } from "./BashInput.tsx";

const multilineCmd = "echo line1\necho line2\necho line3\necho line4\necho line5\necho line6";

describe("BashInput", () => {
  test("show: full command rendered", () => {
    const { lastFrame } = render(
      <BashInput command="ls -la" description="list files" visibility="show" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("ls -la");
  });

  test("hide: shows a one-line tool header but not the command", () => {
    const { lastFrame } = render(
      <BashInput command="rm -rf /" description="dangerous op" visibility="hide" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("rm -rf /");
    expect(frame).toContain("Bash");
  });

  test("summary: first 5 lines + remaining-line indicator for multi-line scripts", () => {
    const { lastFrame } = render(
      <BashInput command={multilineCmd} description="multi" visibility="summary" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("echo line1");
    expect(frame).toContain("echo line5");
    expect(frame).not.toContain("echo line6");
    expect(frame).toMatch(/1 more line/);
  });

  test("summary on single-line command: shows whole command (no truncation)", () => {
    const { lastFrame } = render(
      <BashInput command="ls -la" description="d" visibility="summary" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("ls -la");
    expect(frame).not.toMatch(/more line/);
  });

  test("dim: full command with dim styling", () => {
    const { lastFrame } = render(<BashInput command="ls -la" description="d" visibility="dim" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("ls -la");
    expect(frame).toMatch(/\x1B\[2m/);
  });

  test("show vs hide vs summary produce different output", () => {
    const props = { command: multilineCmd, description: "m" };
    const showFrame = render(<BashInput {...props} visibility="show" />).lastFrame() ?? "";
    const hideFrame = render(<BashInput {...props} visibility="hide" />).lastFrame() ?? "";
    const sumFrame = render(<BashInput {...props} visibility="summary" />).lastFrame() ?? "";
    expect(showFrame).not.toBe(hideFrame);
    expect(showFrame).not.toBe(sumFrame);
    expect(sumFrame).not.toBe(hideFrame);
  });
});
