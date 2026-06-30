import { describe, expect, test } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { Filtered } from "./Filtered";

describe("Filtered", () => {
  const hidden = <Text>HIDDEN</Text>;
  const summary = <Text>SUMMARY</Text>;
  const full = ({ dim }: { dim: boolean }) => (
    <Text dimColor={dim}>{`FULL${dim ? "-DIM" : ""}`}</Text>
  );

  test("hide: renders the hidden node", () => {
    const { lastFrame } = render(
      <Filtered visibility="hide" hidden={hidden} summary={summary} full={full} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("HIDDEN");
    expect(frame).not.toContain("SUMMARY");
    expect(frame).not.toContain("FULL");
  });

  test("summary: renders the summary node", () => {
    const { lastFrame } = render(
      <Filtered visibility="summary" hidden={hidden} summary={summary} full={full} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("SUMMARY");
    expect(frame).not.toContain("HIDDEN");
    expect(frame).not.toContain("FULL");
  });

  test("dim: calls full with dim=true", () => {
    const { lastFrame } = render(
      <Filtered visibility="dim" hidden={hidden} summary={summary} full={full} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("FULL-DIM");
    expect(frame).toMatch(/\x1B\[2m/);
  });

  test("show: calls full with dim=false", () => {
    const { lastFrame } = render(
      <Filtered visibility="show" hidden={hidden} summary={summary} full={full} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("FULL");
    expect(frame).not.toContain("FULL-DIM");
    expect(frame).not.toMatch(/\x1B\[2m/);
  });

  test("hide with null hidden node renders nothing", () => {
    const { lastFrame } = render(
      <Filtered visibility="hide" hidden={null} summary={summary} full={full} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("SUMMARY");
    expect(frame).not.toContain("FULL");
  });
});
