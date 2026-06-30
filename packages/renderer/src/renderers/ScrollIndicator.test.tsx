import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { ScrollIndicator, thumbGeometry } from "./ScrollIndicator";

describe("thumbGeometry", () => {
  test("returns null when content fits (maxScroll === 0)", () => {
    expect(thumbGeometry({ scrollOffset: 0, maxScroll: 0, viewportHeight: 10 })).toBeNull();
  });

  test("returns null for a non-positive viewport", () => {
    expect(thumbGeometry({ scrollOffset: 0, maxScroll: 5, viewportHeight: 0 })).toBeNull();
  });

  test("thumb size is proportional to viewport/content, top at 0 when at top", () => {
    // content = maxScroll + viewportHeight = 10 + 10 = 20; size = round(10*10/20) = 5
    const geom = thumbGeometry({ scrollOffset: 0, maxScroll: 10, viewportHeight: 10 });
    expect(geom).toEqual({ top: 0, size: 5 });
  });

  test("thumb sits at the bottom when scrolled to maxScroll", () => {
    const geom = thumbGeometry({ scrollOffset: 10, maxScroll: 10, viewportHeight: 10 });
    // travel = viewportHeight - size = 10 - 5 = 5
    expect(geom).toEqual({ top: 5, size: 5 });
  });

  test("thumb tracks an intermediate offset", () => {
    const geom = thumbGeometry({ scrollOffset: 5, maxScroll: 10, viewportHeight: 10 });
    // size 5 (offset-independent); travel = 5; round(0.5 * 5) = 3 (round-half-up)
    expect(geom).toEqual({ top: 3, size: 5 });
  });

  test("thumb size is clamped to at least 1 row for huge content", () => {
    const geom = thumbGeometry({ scrollOffset: 0, maxScroll: 990, viewportHeight: 10 });
    // round(10*10/1000) = 0 -> clamped to 1
    expect(geom?.size).toBe(1);
  });

  test("thumb never overruns the track", () => {
    const vh = 10;
    const geom = thumbGeometry({ scrollOffset: 990, maxScroll: 990, viewportHeight: vh });
    expect(geom).not.toBeNull();
    if (geom) expect(geom.top + geom.size).toBeLessThanOrEqual(vh);
  });

  test("out-of-range offsets are clamped into [0, maxScroll]", () => {
    const lo = thumbGeometry({ scrollOffset: -50, maxScroll: 10, viewportHeight: 10 });
    const hi = thumbGeometry({ scrollOffset: 999, maxScroll: 10, viewportHeight: 10 });
    expect(lo?.top).toBe(0);
    expect(hi?.top).toBe(5);
  });
});

describe("ScrollIndicator", () => {
  test("renders nothing when not scrollable", () => {
    const { lastFrame } = render(
      <ScrollIndicator scrollOffset={0} maxScroll={0} viewportHeight={10} />,
    );
    expect(lastFrame() ?? "").toBe("");
  });

  test("renders a one-column track of viewportHeight rows when scrollable", () => {
    const vh = 6;
    const { lastFrame } = render(
      <ScrollIndicator scrollOffset={0} maxScroll={12} viewportHeight={vh} />,
    );
    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");
    expect(lines).toHaveLength(vh);
    // Every visual line is exactly one column wide (thumb or track glyph).
    for (const line of lines) {
      expect(line.replace(/\x1B\[[0-9;]*m/g, "")).toHaveLength(1);
    }
  });

  test("paints the thumb glyph at the top when at offset 0", () => {
    const { lastFrame } = render(
      <ScrollIndicator scrollOffset={0} maxScroll={10} viewportHeight={10} />,
    );
    const lines = (lastFrame() ?? "").split("\n").map((l) => l.replace(/\x1B\[[0-9;]*m/g, ""));
    // size 5 thumb at top: first row is the thumb glyph, last row is track.
    expect(lines[0]).toBe("█");
    expect(lines[9]).toBe("│");
  });

  test("paints the thumb at the bottom when following (offset === maxScroll)", () => {
    const { lastFrame } = render(
      <ScrollIndicator scrollOffset={10} maxScroll={10} viewportHeight={10} />,
    );
    const lines = (lastFrame() ?? "").split("\n").map((l) => l.replace(/\x1B\[[0-9;]*m/g, ""));
    expect(lines[0]).toBe("│");
    expect(lines[9]).toBe("█");
  });
});
