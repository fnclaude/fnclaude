import { Box, Text } from "ink";
import type { JSX } from "react";

export interface ScrollIndicatorProps {
  /** Current scroll position (>= 0), as owned by useAnchoredScroll. */
  scrollOffset: number;
  /** Largest valid offset; `contentHeight - viewportHeight`, never negative. */
  maxScroll: number;
  /** Clipped viewport height in rows — the indicator's full track height. */
  viewportHeight: number;
}

export interface ThumbGeometry {
  /** Thumb's top row within the track (0-based). */
  top: number;
  /** Thumb height in rows (>= 1). */
  size: number;
}

const TRACK_GLYPH = "│";
const THUMB_GLYPH = "█";

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Pure thumb geometry for the scroll indicator. Returns `null` when there's
 * nothing to scroll (content fits the viewport) or the viewport is degenerate —
 * the caller renders nothing in that case.
 *
 * The thumb height is proportional to the visible fraction
 * (`viewportHeight / contentHeight`, where `contentHeight = maxScroll +
 * viewportHeight`), clamped to at least one row. Its top tracks `scrollOffset`
 * across the available travel: at `0` it pins to the top, at `maxScroll` to the
 * bottom — so sticky-follow (offset === maxScroll) lands the thumb at the floor.
 */
export function thumbGeometry(props: ScrollIndicatorProps): ThumbGeometry | null {
  const { scrollOffset, maxScroll, viewportHeight } = props;
  if (maxScroll <= 0 || viewportHeight <= 0) return null;

  const contentHeight = maxScroll + viewportHeight;
  const size = clamp(
    Math.round((viewportHeight * viewportHeight) / contentHeight),
    1,
    viewportHeight,
  );
  const travel = viewportHeight - size;
  const offset = clamp(scrollOffset, 0, maxScroll);
  const top = clamp(Math.round((offset / maxScroll) * travel), 0, travel);

  return { top, size };
}

/**
 * A compact, one-column vertical scroll-position indicator for the transcript
 * viewport. Renders a full-height track with a proportional thumb; renders
 * nothing when the content fits (`maxScroll === 0`). Purely presentational —
 * all state derives from the `useAnchoredScroll` controller passed in by App.
 */
export function ScrollIndicator(props: ScrollIndicatorProps): JSX.Element | null {
  const geom = thumbGeometry(props);
  if (geom === null) return null;

  const rows = Array.from({ length: props.viewportHeight }, (_, i) => {
    const isThumb = i >= geom.top && i < geom.top + geom.size;
    return (
      // The track is a fixed-length list of positional rows that never reorder,
      // so the row index is a stable, correct key.
      // biome-ignore lint/suspicious/noArrayIndexKey: positional track rows never reorder
      <Text key={i} dimColor={!isThumb}>
        {isThumb ? THUMB_GLYPH : TRACK_GLYPH}
      </Text>
    );
  });

  return (
    <Box flexDirection="column" flexShrink={0} width={1}>
      {rows}
    </Box>
  );
}
