import type { ReactElement, ReactNode } from "react";
import type { Visibility } from "../types/events";

export interface FilteredProps {
  visibility: Visibility;
  /** Rendered when visibility is "hide" (pass null to render nothing). */
  hidden: ReactNode;
  /** Rendered when visibility is "summary". */
  summary: ReactNode;
  /** Renders the full body; `dim` is true for "dim", false for "show". */
  full: (opts: { dim: boolean }) => ReactElement;
}

/**
 * Single home for the 4-way visibility ladder shared by every per-tool
 * renderer. Dispatches on {@link Visibility} so the exhaustiveness check
 * lives in exactly one place instead of being hand-copied per renderer.
 *
 *   hide     — the `hidden` node (often a one-line header, or null)
 *   summary  — the `summary` node
 *   dim      — `full({ dim: true })`  (full body, ANSI-faint)
 *   show     — `full({ dim: false })` (full body)
 */
export function Filtered({
  visibility,
  hidden,
  summary,
  full,
}: FilteredProps): ReactElement | null {
  switch (visibility) {
    case "hide":
      return <>{hidden}</>;
    case "summary":
      return <>{summary}</>;
    case "dim":
      return full({ dim: true });
    case "show":
      return full({ dim: false });
  }
}
