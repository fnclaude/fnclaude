import { Box, useBoxMetrics } from "ink";
import { type ReactElement, type ReactNode, useEffect, useRef } from "react";

export interface MeasuredRowProps {
  id: string;
  /** Reports this row's measured (unclipped) height whenever it changes. */
  onHeight: (id: string, rows: number) => void;
  children: ReactNode;
}

/**
 * Wraps a single transcript row in a measured Box and reports its unclipped
 * height up to the scroll controller. Presentational — it knows nothing about
 * scroll state, filters, or what the row contains.
 */
export function MeasuredRow({ id, onHeight, children }: MeasuredRowProps): ReactElement {
  const rowRef = useRef(null);
  const { height, hasMeasured } = useBoxMetrics(rowRef);

  useEffect(() => {
    if (hasMeasured) onHeight(id, height);
  }, [id, height, hasMeasured, onHeight]);

  return (
    <Box ref={rowRef} flexDirection="column">
      {children}
    </Box>
  );
}
