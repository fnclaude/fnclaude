import { describe, expect, test } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import type { AnchoredScroll } from "./useAnchoredScroll.ts";
import { useAnchoredScroll } from "./useAnchoredScroll.ts";

/**
 * ink-testing-library has no "wait" helper; yield the microtask queue plus one
 * real macrotask so React's effect-commit + our layout effect settle before we
 * read the captured controller. Mirrors App.test.tsx's flush.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/**
 * Renders the hook and captures the latest controller into `ref.current` so the
 * test can drive the generic height/order signals and assert resulting state.
 */
function mountController(viewportHeight: number): { current: AnchoredScroll } {
  const ref: { current: AnchoredScroll | null } = { current: null };
  function Harness(): React.ReactElement {
    const ctl = useAnchoredScroll({ viewportHeight });
    ref.current = ctl;
    return (
      <Text>
        {ctl.scrollOffset}/{ctl.isFollowing ? "F" : "-"}/{ctl.maxScroll}
      </Text>
    );
  }
  render(<Harness />);
  return ref as { current: AnchoredScroll };
}

describe("useAnchoredScroll — sticky-follow", () => {
  test("following pins the offset to the bottom as content grows", async () => {
    const ctl = mountController(10);
    await flush();
    expect(ctl.current.isFollowing).toBe(true);
    expect(ctl.current.scrollOffset).toBe(0);

    ctl.current.setOrderedIds(["a", "b", "c"]);
    ctl.current.reportRowHeight("a", 10);
    ctl.current.reportRowHeight("b", 10);
    ctl.current.reportRowHeight("c", 10);
    ctl.current.setContentHeight(30);
    await flush();

    expect(ctl.current.maxScroll).toBe(20);
    expect(ctl.current.scrollOffset).toBe(20); // pinned to bottom while following
    expect(ctl.current.isFollowing).toBe(true);
  });
});

describe("useAnchoredScroll — unfollow on scroll up", () => {
  test("scrolling up releases follow and moves the offset up by one row", async () => {
    const ctl = mountController(10);
    ctl.current.setOrderedIds(["a", "b", "c"]);
    ctl.current.reportRowHeight("a", 10);
    ctl.current.reportRowHeight("b", 10);
    ctl.current.reportRowHeight("c", 10);
    ctl.current.setContentHeight(30);
    await flush();
    expect(ctl.current.scrollOffset).toBe(20);

    ctl.current.onScroll("lineUp");
    await flush();
    expect(ctl.current.isFollowing).toBe(false);
    expect(ctl.current.scrollOffset).toBe(19);
  });
});

describe("useAnchoredScroll — resume follow at bottom", () => {
  test("scrolling back to the bottom resumes following", async () => {
    const ctl = mountController(10);
    ctl.current.setOrderedIds(["a", "b", "c"]);
    ctl.current.reportRowHeight("a", 10);
    ctl.current.reportRowHeight("b", 10);
    ctl.current.reportRowHeight("c", 10);
    ctl.current.setContentHeight(30);
    await flush();

    ctl.current.onScroll("lineUp");
    await flush();
    expect(ctl.current.isFollowing).toBe(false);

    ctl.current.onScroll("lineDown");
    await flush();
    // back at maxScroll → follow resumes
    expect(ctl.current.scrollOffset).toBe(20);
    expect(ctl.current.isFollowing).toBe(true);
  });

  test('"bottom" jumps to the end and resumes following', async () => {
    const ctl = mountController(10);
    ctl.current.setOrderedIds(["a", "b", "c"]);
    ctl.current.reportRowHeight("a", 10);
    ctl.current.reportRowHeight("b", 10);
    ctl.current.reportRowHeight("c", 10);
    ctl.current.setContentHeight(30);
    await flush();

    ctl.current.onScroll("top");
    await flush();
    expect(ctl.current.scrollOffset).toBe(0);
    expect(ctl.current.isFollowing).toBe(false);

    ctl.current.onScroll("bottom");
    await flush();
    expect(ctl.current.scrollOffset).toBe(20);
    expect(ctl.current.isFollowing).toBe(true);
  });
});

describe("useAnchoredScroll — reanchor while not following", () => {
  test("adding a row above the fold keeps the visible top line put", async () => {
    const ctl = mountController(10);
    ctl.current.setOrderedIds(["a", "b", "c"]);
    ctl.current.reportRowHeight("a", 10);
    ctl.current.reportRowHeight("b", 10);
    ctl.current.reportRowHeight("c", 10);
    ctl.current.setContentHeight(30);
    await flush();

    // scroll up to offset 18 → anchor is b at subOffset 8, following released
    ctl.current.onScroll("lineUp");
    await flush();
    ctl.current.onScroll("lineUp");
    await flush();
    expect(ctl.current.isFollowing).toBe(false);
    expect(ctl.current.scrollOffset).toBe(18);

    // insert x (height 10) at the very top, above the fold
    ctl.current.setOrderedIds(["x", "a", "b", "c"]);
    ctl.current.reportRowHeight("x", 10);
    ctl.current.setContentHeight(40);
    await flush();

    // anchor b's new top is 20; subOffset 8 → 28. Offset rose by exactly x's
    // height (10), so the visible top line (row b) stayed put.
    expect(ctl.current.scrollOffset).toBe(28);
    expect(ctl.current.isFollowing).toBe(false);
  });
});
