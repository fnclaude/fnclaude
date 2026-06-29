import { Box, Text } from "ink";
import type { Token, Tokens } from "marked";
import type { JSX } from "react";

export type AlertKind = "note" | "tip" | "important" | "warning" | "caution";

const ALERT_META: Record<AlertKind, { color: string; icon: string; label: string }> = {
  note: { color: "blue", icon: "ℹ", label: "Note" },
  tip: { color: "green", icon: "💡", label: "Tip" },
  important: { color: "magenta", icon: "❗", label: "Important" },
  warning: { color: "yellow", icon: "⚠", label: "Warning" },
  caution: { color: "red", icon: "🛑", label: "Caution" },
};

const ALERT_PATTERN = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i;

/**
 * Parses a blockquote token as a GitHub-style callout / alert.
 *
 * Returns `{ kind, bodyTokens }` when the blockquote's first paragraph begins
 * with `[!KIND]`, with the marker line stripped from `bodyTokens`.
 * Returns `null` for plain blockquotes.
 */
export function parseAlert(
  token: Tokens.Blockquote,
): { kind: AlertKind; bodyTokens: Token[] } | null {
  const tokens = token.tokens;
  if (tokens.length === 0) return null;

  const first = tokens[0];
  if (first === undefined || first.type !== "paragraph") return null;

  const para = first as Tokens.Paragraph;
  const text = para.text.trimStart();
  const match = text.match(ALERT_PATTERN);
  if (!match) return null;

  const kind = (match[1] ?? "note").toLowerCase() as AlertKind;

  // Strip the [!KIND] marker line from the first paragraph.
  // The text after the marker (same paragraph, separated by \n) becomes
  // the body of a new paragraph token. If nothing remains, drop the para.
  const afterMarker = text.slice(match[0].length).replace(/^\n/, "");
  const rest = tokens.slice(1);

  let bodyTokens: Token[];
  if (afterMarker.trim().length === 0) {
    // Marker was alone on its own line; body is the remaining tokens.
    bodyTokens = rest;
  } else {
    // Body text follows on subsequent lines in the same paragraph.
    const bodyPara: Tokens.Paragraph = {
      type: "paragraph",
      raw: afterMarker,
      text: afterMarker,
      tokens: [
        {
          type: "text",
          raw: afterMarker,
          text: afterMarker,
        } as Tokens.Text,
      ],
    };
    bodyTokens = [bodyPara, ...rest];
  }

  return { kind, bodyTokens };
}

export interface AlertBlockProps {
  kind: AlertKind;
  bodyTokens: Token[];
  renderChildren: (tokens: Token[]) => React.ReactNode;
}

/**
 * Renders a GitHub-style alert callout in Ink.
 *
 * Displays a left-border accent, an icon + Title-Case header line, then
 * delegates body rendering to the injected `renderChildren` callback so the
 * component stays decoupled from MarkdownRenderer.
 */
export function AlertBlock({ kind, bodyTokens, renderChildren }: AlertBlockProps): JSX.Element {
  const { color, icon, label } = ALERT_META[kind];
  return (
    <Box
      borderStyle="single"
      borderColor={color}
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      paddingLeft={1}
      marginBottom={1}
      flexDirection="column"
    >
      <Text color={color} bold>
        {icon} {label}
      </Text>
      {renderChildren(bodyTokens)}
    </Box>
  );
}
