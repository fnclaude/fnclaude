/**
 * Public surface of slice C — per-event Ink renderers.
 *
 * Slice B imports from this module:
 *   import { TextRenderer, ToolUseRenderer, ToolResultRenderer, ... } from "./renderers";
 *
 * Three categories:
 *   1. Top-level dispatchers   — ToolUseRenderer, ToolResultRenderer
 *   2. Per-event renderers     — TextRenderer, ThinkingRenderer, SystemInit,
 *                                ErrorRenderer, ResultRenderer
 *   3. Per-tool element views  — BashInput, BashOutput, EditDiff,
 *                                ReadInput, ReadContent, WriteContent,
 *                                TaskNested
 *
 * All filterable per-tool views accept a `visibility: Visibility` prop;
 * the dispatchers consume a `visibilityFor: (id) => Visibility` resolver
 * supplied by slice B.
 */

export { BashInput } from "./BashInput.tsx";
export type { BashInputProps } from "./BashInput.tsx";
export { BashOutput } from "./BashOutput.tsx";
export type { BashOutputProps } from "./BashOutput.tsx";
export { EditDiff } from "./EditDiff.tsx";
export type { EditDiffProps } from "./EditDiff.tsx";
export { ErrorRenderer } from "./ErrorRenderer.tsx";
export type { ErrorRendererProps } from "./ErrorRenderer.tsx";
export { ReadContent } from "./ReadContent.tsx";
export type { ReadContentProps } from "./ReadContent.tsx";
export { ReadInput } from "./ReadInput.tsx";
export type { ReadInputProps } from "./ReadInput.tsx";
export { ResultRenderer } from "./ResultRenderer.tsx";
export type { ResultRendererProps } from "./ResultRenderer.tsx";
export { SystemInit } from "./SystemInit.tsx";
export type { SystemInitProps } from "./SystemInit.tsx";
export { TaskNested } from "./TaskNested.tsx";
export type { TaskNestedProps } from "./TaskNested.tsx";
export {
  detectGlowPath,
  type GlowRunner,
  runGlow,
  TextRenderer,
} from "./TextRenderer.tsx";
export type { TextRendererProps } from "./TextRenderer.tsx";
export { ThinkingRenderer } from "./ThinkingRenderer.tsx";
export type { ThinkingRendererProps } from "./ThinkingRenderer.tsx";
export { ToolResultRenderer } from "./ToolResultRenderer.tsx";
export type { ToolResultRendererProps } from "./ToolResultRenderer.tsx";
export { ToolUseRenderer } from "./ToolUseRenderer.tsx";
export type { ToolUseRendererProps } from "./ToolUseRenderer.tsx";
