import { Text } from "ink";
import type { ElementId, ToolUseBlock, Visibility } from "../types/events.ts";
import { BashInput } from "./BashInput.tsx";
import { EditDiff } from "./EditDiff.tsx";
import { ReadInput } from "./ReadInput.tsx";
import { TaskNested } from "./TaskNested.tsx";
import { WriteContent } from "./WriteContent.tsx";

export interface ToolUseRendererProps {
  block: ToolUseBlock;
  /**
   * Resolves the current visibility for a given filterable element id.
   * Slice B owns filter state; this dispatcher only consults the
   * function for the element id corresponding to the block's tool.
   */
  visibilityFor: (id: ElementId) => Visibility;
}

/**
 * Generic dispatcher for ToolUseBlocks. Reads `block.name`, pulls the
 * right input fields, and renders the matching per-tool component with
 * the visibility resolved for that tool's element id.
 *
 * Unknown tools fall back to a one-line header showing the tool name and
 * a compact input summary.
 */
export function ToolUseRenderer({ block, visibilityFor }: ToolUseRendererProps): JSX.Element {
  const input = block.input;

  switch (block.name) {
    case "Bash":
      return (
        <BashInput
          command={asString(input.command)}
          description={asOptionalString(input.description)}
          visibility={visibilityFor("Bash.input")}
        />
      );

    case "Edit":
      return (
        <EditDiff
          filePath={asString(input.file_path)}
          oldString={asString(input.old_string)}
          newString={asString(input.new_string)}
          visibility={visibilityFor("Edit.diff")}
        />
      );

    case "Read":
      return (
        <ReadInput
          filePath={asString(input.file_path)}
          offset={asOptionalNumber(input.offset)}
          limit={asOptionalNumber(input.limit)}
        />
      );

    case "Write":
      return (
        <WriteContent
          filePath={asString(input.file_path)}
          content={asString(input.content)}
          visibility={visibilityFor("Write.content")}
        />
      );

    case "Task":
      return (
        <TaskNested
          description={asOptionalString(input.description)}
          prompt={asString(input.prompt)}
          visibility={visibilityFor("Task.nested")}
        />
      );

    default:
      return <Text>{`▸ ${block.name}: ${summarizeInput(input)}`}</Text>;
  }
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asOptionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asOptionalNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** Compact one-line summary of arbitrary tool input. */
function summarizeInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input);
  if (entries.length === 0) return "(no input)";
  const parts = entries.slice(0, 3).map(([k, v]) => `${k}=${oneLine(v)}`);
  return parts.join(" ");
}

function oneLine(v: unknown): string {
  if (typeof v === "string") {
    const flat = v.replace(/\s+/g, " ").trim();
    return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
