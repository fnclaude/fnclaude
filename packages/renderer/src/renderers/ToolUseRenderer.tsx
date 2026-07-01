import type { JSX } from "react";
import type { ElementId, ToolUseBlock, Visibility } from "../types/events";
import { BashInput } from "./BashInput";
import { EditDiff } from "./EditDiff";
import { GenericTool, salientArg } from "./GenericTool";
import { ReadInput } from "./ReadInput";
import { TaskNested } from "./TaskNested";
import { WriteContent } from "./WriteContent";

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
 * Unknown tools fall back to the generic structured renderer: a header with
 * the tool name plus a filterable key/value body (summary/verbose per the
 * shared `tool.generic` element id), instead of a raw-JSON dump.
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
      // Unknown tool: generic structured key/value view. Shares the single
      // `tool.generic` element id (the Alt+digit table is full and the tool
      // set is open-ended). `block.id` is the stable per-instance key for the
      // #285 expand seam; no override resolver is wired yet, so it stays inert.
      return (
        <GenericTool
          header={`▸ ${block.name}`}
          body={input}
          salient={salientArg(input)}
          visibility={visibilityFor("tool.generic")}
          blockId={block.id}
        />
      );
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
