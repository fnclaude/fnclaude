import type { JSX } from "react";
import { MarkdownRenderer } from "./MarkdownRenderer.tsx";

export interface TextRendererProps {
  text: string;
}

/**
 * Renders an AssistantEvent.message.content[] TextBlock.
 *
 * Thin delegate to {@link MarkdownRenderer} — the old `glow` subprocess path
 * has been removed in favour of native Ink markdown components (real bold,
 * real colors, zero visible markup characters). Kept as a named export for
 * call-site stability.
 */
export function TextRenderer({ text }: TextRendererProps): JSX.Element {
  return <MarkdownRenderer text={text} />;
}
