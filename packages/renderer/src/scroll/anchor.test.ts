import { describe, expect, test } from "bun:test";
import {
  type LayoutSnapshot,
  contentHeight,
  cumulativeTops,
  firstVisible,
  maxScroll,
  reanchor,
} from "./anchor.ts";

/** Five rows of height 10: tops 0,10,20,30,40; total 50. */
const h5 = { a: 10, b: 10, c: 10, d: 10, e: 10 };
const ids5 = ["a", "b", "c", "d", "e"];

describe("cumulativeTops", () => {
  test("first row at 0, each subsequent at running sum", () => {
    expect(cumulativeTops(ids5, h5)).toEqual({ a: 0, b: 10, c: 20, d: 30, e: 40 });
  });

  test("variable heights", () => {
    expect(cumulativeTops(["x", "y", "z"], { x: 3, y: 7, z: 2 })).toEqual({ x: 0, y: 3, z: 10 });
  });

  test("missing heights count as 0", () => {
    expect(cumulativeTops(["a", "b", "c"], { a: 5, c: 4 })).toEqual({ a: 0, b: 5, c: 5 });
  });

  test("empty", () => {
    expect(cumulativeTops([], {})).toEqual({});
  });
});

describe("contentHeight", () => {
  test("sum of heights in order", () => {
    expect(contentHeight(ids5, h5)).toBe(50);
  });

  test("missing heights count as 0", () => {
    expect(contentHeight(["a", "b", "c"], { a: 5, c: 4 })).toBe(9);
  });

  test("empty is 0", () => {
    expect(contentHeight([], {})).toBe(0);
  });
});

describe("maxScroll", () => {
  test("content taller than viewport", () => {
    expect(maxScroll(50, 15)).toBe(35);
  });

  test("never negative when content fits", () => {
    expect(maxScroll(10, 30)).toBe(0);
    expect(maxScroll(0, 30)).toBe(0);
  });

  test("exactly equal is 0", () => {
    expect(maxScroll(20, 20)).toBe(0);
  });
});

describe("firstVisible", () => {
  const snap = (scrollOffset: number): LayoutSnapshot => ({
    orderedIds: ids5,
    heightById: h5,
    scrollOffset,
    viewportHeight: 15,
  });

  test("offset 0 → first row, subOffset 0", () => {
    expect(firstVisible(snap(0))).toEqual({ id: "a", subOffset: 0 });
  });

  test("offset inside a later row reports subOffset", () => {
    // offset 25: rows a(0..10) b(10..20) end <=25; c(20..30) is first with end>25.
    expect(firstVisible(snap(25))).toEqual({ id: "c", subOffset: 5 });
  });

  test("offset exactly on a row boundary picks the lower row", () => {
    // offset 20: b ends at 20 (not >20), c(20..30) first with end>20, subOffset 0.
    expect(firstVisible(snap(20))).toEqual({ id: "c", subOffset: 0 });
  });

  test("offset at last row", () => {
    expect(firstVisible(snap(45))).toEqual({ id: "e", subOffset: 5 });
  });

  test("empty content → null", () => {
    expect(
      firstVisible({ orderedIds: [], heightById: {}, scrollOffset: 0, viewportHeight: 15 }),
    ).toBeNull();
  });

  test("offset at/past end of content → null", () => {
    expect(firstVisible(snap(50))).toBeNull();
  });
});

describe("reanchor — item above the fold removed", () => {
  test("offset drops by exactly that item's height; anchor row stays pinned", () => {
    // prev: anchor is c at subOffset 5 (offset 25). Remove b (height 10, fully
    // above the fold). The anchor row c must keep its screen position.
    const prev: LayoutSnapshot = {
      orderedIds: ids5,
      heightById: h5,
      scrollOffset: 25,
      viewportHeight: 15,
    };
    const next = {
      orderedIds: ["a", "c", "d", "e"],
      heightById: h5,
      viewportHeight: 15,
    };
    // new top of c = 10, subOffset 5 → 15. Old offset 25 dropped by exactly 10.
    expect(reanchor(prev, next)).toBe(15);
  });
});

describe("reanchor — item above the fold added", () => {
  test("offset rises by exactly the added item's height (inverse of removal)", () => {
    const prev: LayoutSnapshot = {
      orderedIds: ["a", "c", "d", "e"],
      heightById: h5,
      scrollOffset: 15, // anchor c, subOffset 5
      viewportHeight: 15,
    };
    const next = {
      orderedIds: ids5, // b inserted back above c
      heightById: h5,
      viewportHeight: 15,
    };
    // new top of c = 20, subOffset 5 → 25. Rose by exactly 10.
    expect(reanchor(prev, next)).toBe(25);
  });
});

describe("reanchor — anchor row itself removed", () => {
  test("slides to the next surviving row, subOffset 0", () => {
    const prev: LayoutSnapshot = {
      orderedIds: ids5,
      heightById: h5,
      scrollOffset: 25, // anchor c, subOffset 5
      viewportHeight: 15,
    };
    const next = {
      orderedIds: ["a", "b", "d", "e"], // c removed
      heightById: h5,
      viewportHeight: 15,
    };
    // c gone → next surviving row below c is d; its new top is 20, subOffset 0.
    expect(reanchor(prev, next)).toBe(20);
  });

  test("nothing below the anchor survives → pin to bottom (maxScroll)", () => {
    const prev: LayoutSnapshot = {
      orderedIds: ids5,
      heightById: h5,
      scrollOffset: 25, // anchor c
      viewportHeight: 15,
    };
    const next = {
      orderedIds: ["a", "b"], // c, d, e all gone
      heightById: h5,
      viewportHeight: 15,
    };
    // contentHeight 20, maxScroll(20,15) = 5.
    expect(reanchor(prev, next)).toBe(5);
  });
});

describe("reanchor — multiple simultaneous toggles above the fold", () => {
  test("offset drops by the SUMMED height of every removed item above the fold", () => {
    const prev: LayoutSnapshot = {
      orderedIds: ids5,
      heightById: h5,
      scrollOffset: 25, // anchor c, subOffset 5
      viewportHeight: 15,
    };
    const next = {
      orderedIds: ["c", "d", "e"], // a AND b removed (20 total above fold)
      heightById: h5,
      viewportHeight: 15,
    };
    // new top of c = 0, subOffset 5 → 5. Old 25 dropped by exactly 20.
    expect(reanchor(prev, next)).toBe(5);
  });

  test("mixed add+remove above the fold nets to the summed delta", () => {
    const prev: LayoutSnapshot = {
      orderedIds: ids5,
      heightById: h5,
      scrollOffset: 25, // anchor c, subOffset 5
      viewportHeight: 15,
    };
    // Remove b (-10) above the fold, insert f (height 4) at the very top (+4).
    const next = {
      orderedIds: ["f", "a", "c", "d", "e"],
      heightById: { ...h5, f: 4 },
      viewportHeight: 15,
    };
    // new top of c = f(4)+a(10) = 14, subOffset 5 → 19. Net delta -6 from 25.
    expect(reanchor(prev, next)).toBe(19);
  });
});

describe("reanchor — clamping", () => {
  test("desired beyond maxScroll clamps to bottom when content below shrinks", () => {
    const prev: LayoutSnapshot = {
      orderedIds: ids5,
      heightById: h5,
      scrollOffset: 25, // anchor c, subOffset 5
      viewportHeight: 10,
    };
    const next = {
      orderedIds: ["a", "b", "c"], // d, e removed (below the fold)
      heightById: h5,
      viewportHeight: 10,
    };
    // desired = top(c)=20 + 5 = 25, but contentHeight 30, maxScroll(30,10)=20.
    expect(reanchor(prev, next)).toBe(20);
  });

  test("never returns a negative offset", () => {
    const prev: LayoutSnapshot = {
      orderedIds: ids5,
      heightById: h5,
      scrollOffset: 0,
      viewportHeight: 15,
    };
    const next = { orderedIds: ids5, heightById: h5, viewportHeight: 15 };
    expect(reanchor(prev, next)).toBe(0);
  });

  test("nothing visible in prev → prev offset clamped to next maxScroll", () => {
    const prev: LayoutSnapshot = {
      orderedIds: ids5,
      heightById: h5,
      scrollOffset: 50, // at/past end → firstVisible null
      viewportHeight: 15,
    };
    const next = { orderedIds: ["a", "b"], heightById: h5, viewportHeight: 15 };
    // maxScroll(20,15)=5; clamp(50,0,5)=5.
    expect(reanchor(prev, next)).toBe(5);
  });
});
