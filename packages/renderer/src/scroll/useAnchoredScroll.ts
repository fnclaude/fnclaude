import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { type LayoutSnapshot, maxScroll as computeMaxScroll, reanchor } from "./anchor.ts";

export interface AnchoredScrollConfig {
  viewportHeight: number;
}

export interface AnchoredScroll {
  scrollOffset: number;
  isFollowing: boolean;
  maxScroll: number;
  /** Full unclipped content height, from ScrollViewport.onContentHeight. */
  setContentHeight: (rows: number) => void;
  /** Per-row measured height, from MeasuredRow. */
  reportRowHeight: (id: string, rows: number) => void;
  /** Render order of visible rows, declared by the transcript each render. */
  setOrderedIds: (ids: string[]) => void;
  onScroll: (delta: "lineUp" | "lineDown" | "pageUp" | "pageDown" | "top" | "bottom") => void;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function sameOrder(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Owns scroll state for the app-owned viewport. Consumes generic height/order
 * signals (setContentHeight / reportRowHeight / setOrderedIds) and decides the
 * scroll offset via the pure `anchor` math. It carries NO knowledge of
 * transcripts, filters, or token-burn — those are upstream concerns.
 *
 * Behaviour:
 *  - sticky-follow: while following, content growth pins the view to the bottom.
 *  - on scroll up, following is released; the visible top line stays put across
 *    content changes (delta-compensation via anchor.reanchor).
 *  - scrolling back to the bottom resumes following.
 */
export function useAnchoredScroll(cfg: AnchoredScrollConfig): AnchoredScroll {
  const { viewportHeight } = cfg;

  const [scrollOffset, setScrollOffset] = useState(0);
  const [isFollowing, setIsFollowing] = useState(true);
  // Version counter bumped whenever a height/order signal mutates a ref, so the
  // layout effect re-runs after a re-measure even though refs don't trigger one.
  const [version, setVersion] = useState(0);

  const heightByIdRef = useRef<Record<string, number>>({});
  const orderedIdsRef = useRef<string[]>([]);
  const contentHRef = useRef(0);
  const prevSnapshotRef = useRef<LayoutSnapshot | null>(null);
  const scrollOffsetRef = useRef(0);

  // Keep the offset ref in sync with committed state so onScroll and the layout
  // effect both read the user's true current position.
  scrollOffsetRef.current = scrollOffset;

  const ms = computeMaxScroll(contentHRef.current, viewportHeight);

  const reportRowHeight = useCallback((id: string, rows: number) => {
    if (heightByIdRef.current[id] !== rows) {
      heightByIdRef.current[id] = rows;
      setVersion((v) => v + 1);
    }
  }, []);

  const setContentHeight = useCallback((rows: number) => {
    if (contentHRef.current !== rows) {
      contentHRef.current = rows;
      setVersion((v) => v + 1);
    }
  }, []);

  const setOrderedIds = useCallback((ids: string[]) => {
    if (!sameOrder(orderedIdsRef.current, ids)) {
      orderedIdsRef.current = ids;
      setVersion((v) => v + 1);
    }
  }, []);

  // Sticky-follow / reanchor. Re-runs when the measured layout changes (version),
  // when follow state flips, or when the viewport is resized. `version` is a
  // re-run trigger for the ref mutations (heights/order), not read in the body.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version is an intentional re-run trigger
  useLayoutEffect(() => {
    const nextMax = computeMaxScroll(contentHRef.current, viewportHeight);
    let value: number;
    if (isFollowing) {
      value = nextMax;
    } else if (prevSnapshotRef.current) {
      value = reanchor(
        { ...prevSnapshotRef.current, scrollOffset: scrollOffsetRef.current },
        {
          orderedIds: orderedIdsRef.current,
          heightById: heightByIdRef.current,
          viewportHeight,
        },
      );
    } else {
      value = clamp(scrollOffsetRef.current, 0, nextMax);
    }

    scrollOffsetRef.current = value;
    setScrollOffset(value);
    prevSnapshotRef.current = {
      orderedIds: orderedIdsRef.current,
      heightById: heightByIdRef.current,
      viewportHeight,
      scrollOffset: value,
    };
  }, [version, isFollowing, viewportHeight]);

  const onScroll = useCallback(
    (delta: "lineUp" | "lineDown" | "pageUp" | "pageDown" | "top" | "bottom") => {
      const m = computeMaxScroll(contentHRef.current, viewportHeight);
      const cur = scrollOffsetRef.current;
      const page = Math.max(1, viewportHeight - 1);

      let next: number;
      let following: boolean;
      switch (delta) {
        case "lineUp":
          next = clamp(cur - 1, 0, m);
          following = false;
          break;
        case "lineDown":
          next = clamp(cur + 1, 0, m);
          following = next >= m;
          break;
        case "pageUp":
          next = clamp(cur - page, 0, m);
          following = false;
          break;
        case "pageDown":
          next = clamp(cur + page, 0, m);
          following = next >= m;
          break;
        case "top":
          next = 0;
          following = false;
          break;
        case "bottom":
          next = m;
          following = true;
          break;
      }

      scrollOffsetRef.current = next;
      setScrollOffset(next);
      setIsFollowing(following);
    },
    [viewportHeight],
  );

  return {
    scrollOffset,
    isFollowing,
    maxScroll: ms,
    setContentHeight,
    reportRowHeight,
    setOrderedIds,
    onScroll,
  };
}
