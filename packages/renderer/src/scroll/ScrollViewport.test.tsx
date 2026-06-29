import { describe, expect, mock, test } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { ScrollViewport } from "./ScrollViewport.tsx";

// Helper: build N single-row children, each a distinct, greppable label.
function lines(n: number): React.ReactElement[] {
  const labels = Array.from({ length: n }, (_, i) => `line-${i}`);
  return labels.map((label) => <Text key={label}>{label}</Text>);
}

function visibleLineIndices(frame: string | undefined): number[] {
  const out: number[] = [];
  for (const m of (frame ?? "").matchAll(/line-(\d+)/g)) {
    out.push(Number(m[1]));
  }
  return out;
}

describe("ScrollViewport — clipping", () => {
  test("rows beyond the viewport height are absent from the frame", () => {
    const { lastFrame } = render(
      <ScrollViewport height={3} scrollOffset={0}>
        {lines(10)}
      </ScrollViewport>,
    );
    const visible = visibleLineIndices(lastFrame());
    // Only the first 3 rows fit; the rest are clipped away.
    expect(visible).toEqual([0, 1, 2]);
    expect(lastFrame()).not.toContain("line-3");
    expect(lastFrame()).not.toContain("line-9");
  });
});

describe("ScrollViewport — scrollOffset window", () => {
  test("marginTop offset shifts the visible window down the content", () => {
    const { lastFrame } = render(
      <ScrollViewport height={3} scrollOffset={4}>
        {lines(10)}
      </ScrollViewport>,
    );
    const visible = visibleLineIndices(lastFrame());
    // scrollOffset=4 scrolls the first 4 rows off the top; window is rows 4..6.
    expect(visible).toEqual([4, 5, 6]);
    expect(lastFrame()).not.toContain("line-3");
    expect(lastFrame()).not.toContain("line-7");
  });
});

describe("ScrollViewport — onContentHeight", () => {
  test("reports the full UNCLIPPED content height, not the viewport height", async () => {
    const onContentHeight = mock((_rows: number) => {});
    render(
      <ScrollViewport height={3} scrollOffset={0} onContentHeight={onContentHeight}>
        {lines(10)}
      </ScrollViewport>,
    );
    // useBoxMetrics reports after the first layout pass (one async tick).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onContentHeight).toHaveBeenCalled();
    const lastCall = onContentHeight.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe(10);
  });
});
