import { Text } from "ink";

export interface ReadInputProps {
  filePath: string;
  offset?: number | undefined;
  limit?: number | undefined;
}

/**
 * Renders the path being read by a Read tool_use. This is the *call*
 * side; the resulting file content is filterable via Read.content on
 * the result side. The call line itself is always shown — it's a
 * tool-call header, not a filterable element.
 */
export function ReadInput({ filePath, offset, limit }: ReadInputProps): JSX.Element {
  const range =
    offset !== undefined || limit !== undefined ? ` [${offset ?? 0}:${limit ?? "end"}]` : "";
  return <Text>{`▸ Read: ${filePath}${range}`}</Text>;
}
