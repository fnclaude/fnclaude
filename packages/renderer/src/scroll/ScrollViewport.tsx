import { Box, useBoxMetrics } from "ink";
import { useEffect, useRef } from "react";

export interface ScrollViewportProps {
  /** Viewport height in rows. Content beyond this is clipped. */
  height: number;
  /** Scroll position (>=0), applied as marginTop={-scrollOffset} on the inner box. */
  scrollOffset: number;
  /** Reports the full UNCLIPPED content height (useBoxMetrics height of the inner box). */
  onContentHeight?: (rows: number) => void;
  /** Content. Knows NOTHING about transcripts/turns/filters/token-burn. */
  children: React.ReactNode;
}

/**
 * Presentational, content-agnostic scroll viewport.
 *
 * Outer box clips to `height` (overflowY="hidden"); inner box is shifted up by
 * `scrollOffset` via a negative marginTop. `flexShrink={0}` stops Yoga
 * compressing the inner box, so `useBoxMetrics` reports the full unclipped
 * content height — which is fed back out through `onContentHeight`.
 *
 * Owns NO scroll state. The caller decides `scrollOffset`; this component only
 * paints the window and reports how tall the content actually is.
 */
export function ScrollViewport(props: ScrollViewportProps): React.ReactElement {
  const { height, scrollOffset, onContentHeight, children } = props;
  const contentRef = useRef(null);
  const metrics = useBoxMetrics(contentRef);

  useEffect(() => {
    if (metrics.hasMeasured) {
      onContentHeight?.(metrics.height);
    }
  }, [metrics.hasMeasured, metrics.height, onContentHeight]);

  return (
    <Box height={height} overflowY="hidden" flexDirection="column">
      <Box ref={contentRef} flexDirection="column" flexShrink={0} marginTop={-scrollOffset}>
        {children}
      </Box>
    </Box>
  );
}
