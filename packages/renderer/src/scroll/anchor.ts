/**
 * Pure scroll-anchoring math. No React, no Ink — the hard logic lives here so
 * it can be unit-tested exhaustively in isolation.
 *
 * The controller (useAnchoredScroll) owns the state and feeds these functions
 * generic layout snapshots; this module decides where the viewport should sit
 * after content above (or below) the fold appears or disappears.
 */

export interface LayoutSnapshot {
  /** Render order of measured rows. */
  orderedIds: string[];
  /** Measured unclipped height per row. */
  heightById: Record<string, number>;
  /** Current marginTop offset (>=0). */
  scrollOffset: number;
  /** Clipped viewport height in rows. */
  viewportHeight: number;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Cumulative top (y-offset) of each row in render order. The first row sits at
 * 0; every subsequent row sits at the running sum of the heights before it.
 * Missing heights count as 0.
 */
export function cumulativeTops(ids: string[], h: Record<string, number>): Record<string, number> {
  const tops: Record<string, number> = {};
  let acc = 0;
  for (const id of ids) {
    tops[id] = acc;
    acc += h[id] ?? 0;
  }
  return tops;
}

/** Total height of all rows in render order. Missing heights count as 0. */
export function contentHeight(ids: string[], h: Record<string, number>): number {
  let acc = 0;
  for (const id of ids) acc += h[id] ?? 0;
  return acc;
}

/** Largest valid scroll offset — never negative. */
export function maxScroll(contentHeightRows: number, viewportHeight: number): number {
  return Math.max(0, contentHeightRows - viewportHeight);
}

/**
 * The first row intersecting the top edge of the viewport, plus how far into
 * that row the fold currently sits (subOffset = scrollOffset - row top).
 *
 * Returns null when nothing is visible (empty content, or the offset sits at or
 * past the end of all content).
 */
export function firstVisible(s: LayoutSnapshot): { id: string; subOffset: number } | null {
  let acc = 0;
  for (const id of s.orderedIds) {
    const height = s.heightById[id] ?? 0;
    if (acc + height > s.scrollOffset) {
      return { id, subOffset: s.scrollOffset - acc };
    }
    acc += height;
  }
  return null;
}

/**
 * The delta-compensation. Given the previous layout+offset and the next layout,
 * return the scroll offset that keeps the visible top line invariant across the
 * change — even when multiple rows above the fold toggle at once.
 *
 * Strategy: find the row anchoring the top of the viewport in `prev`. If it
 * survives into `next`, place it back under the fold at the same sub-row offset
 * (its new cumulative top already encodes the net height delta of everything
 * above it). If the anchor row itself was removed, slide to the next surviving
 * row below it. If nothing below survives, pin to the bottom.
 */
export function reanchor(
  prev: LayoutSnapshot,
  next: { orderedIds: string[]; heightById: Record<string, number>; viewportHeight: number },
): number {
  const nextCH = contentHeight(next.orderedIds, next.heightById);
  const ms = maxScroll(nextCH, next.viewportHeight);

  const anchor = firstVisible(prev);
  if (anchor === null) {
    return clamp(prev.scrollOffset, 0, ms);
  }

  const nextTops = cumulativeTops(next.orderedIds, next.heightById);

  let desired: number;
  if (anchor.id in nextTops) {
    // Anchor survives: its new cumulative top encodes the summed height delta of
    // everything above it, regardless of how many rows toggled.
    desired = nextTops[anchor.id] + anchor.subOffset;
  } else {
    // Anchor row was removed: slide to the first row below it that still exists.
    const anchorIdx = prev.orderedIds.indexOf(anchor.id);
    let survivor: string | undefined;
    for (let i = anchorIdx + 1; i < prev.orderedIds.length; i++) {
      const id = prev.orderedIds[i];
      if (id in nextTops) {
        survivor = id;
        break;
      }
    }
    desired = survivor === undefined ? ms : nextTops[survivor];
  }

  return clamp(desired, 0, ms);
}
