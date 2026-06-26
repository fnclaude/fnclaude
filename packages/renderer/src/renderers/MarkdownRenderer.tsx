import { Box, Text } from "ink";
import { type Token, type Tokens, marked } from "marked";
import remend from "remend";

export interface MarkdownRendererProps {
  /** Raw (possibly partial/streaming) markdown. */
  text: string;
}

/**
 * Native Ink markdown renderer — replaces the old `glow` subprocess.
 *
 * `remend` heals partial/streaming markdown (closes dangling `**`, `*`,
 * `` ` ``, and unclosed fences) BEFORE lexing, so per-delta live previews
 * never leak a stray syntax character. `marked.lexer` then produces a typed
 * token tree; the walk below maps each token to real Ink components with real
 * bold/italic/color. Because marked consumes every syntax character into token
 * metadata (`**`, `#`, backticks, fence markers all live in `raw`, never
 * `text`), nothing markup-ish ever reaches a `<Text>`.
 */
export function MarkdownRenderer({ text }: MarkdownRendererProps): JSX.Element {
  const healed = remend(text);
  const tokens = marked.lexer(healed);
  return (
    <Box flexDirection="column">
      {tokens.map((token, i) => (
        <BlockToken key={`b-${i}`} token={token} />
      ))}
    </Box>
  );
}

const HEADING_COLOR = "cyan";

/** A single block-level token → its block element (or null for whitespace). */
function BlockToken({ token }: { token: Token }): JSX.Element | null {
  switch (token.type) {
    case "heading":
      return (
        <Box marginBottom={1}>
          <Text bold color={HEADING_COLOR}>
            {inline((token as Tokens.Heading).tokens)}
          </Text>
        </Box>
      );
    case "paragraph":
      return (
        <Box marginBottom={1}>
          <Text>{inline((token as Tokens.Paragraph).tokens)}</Text>
        </Box>
      );
    case "text": {
      const tt = token as Tokens.Text;
      return <Text>{tt.tokens ? inline(tt.tokens) : tt.text}</Text>;
    }
    case "code": {
      const code = token as Tokens.Code;
      return (
        <Box
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          marginBottom={1}
          flexDirection="column"
        >
          <Text color="green">{code.text}</Text>
        </Box>
      );
    }
    case "blockquote": {
      const bq = token as Tokens.Blockquote;
      return (
        <Box
          borderStyle="single"
          borderColor="gray"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          paddingLeft={1}
          marginBottom={1}
          flexDirection="column"
        >
          {bq.tokens.map((t, i) => (
            <BlockToken key={`b-${i}`} token={t} />
          ))}
        </Box>
      );
    }
    case "list":
      return <ListBlock token={token as Tokens.List} />;
    case "hr":
      return (
        <Box marginBottom={1}>
          <Text dimColor>{"─".repeat(40)}</Text>
        </Box>
      );
    case "space":
      return null;
    case "html":
      // Raw HTML is rare in assistant output; show its text plainly rather
      // than dropping it.
      return <Text>{(token as Tokens.HTML).text}</Text>;
    default:
      return <Text>{"text" in token ? (token as { text: string }).text : ""}</Text>;
  }
}

function ListBlock({ token }: { token: Tokens.List }): JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {token.items.map((item, i) => {
        const marker = token.ordered
          ? `${(typeof token.start === "number" ? token.start : 1) + i}.`
          : "●";
        return (
          <Box key={`li-${i}`} flexDirection="row">
            {token.ordered ? (
              <Text color="yellow">{`${marker} `}</Text>
            ) : (
              <Text color="cyan">{`${marker} `}</Text>
            )}
            <Box flexDirection="column">
              <ListItemBody item={item} />
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function ListItemBody({ item }: { item: Tokens.ListItem }): JSX.Element {
  return (
    <>
      {item.tokens.map((t, i) => {
        if (t.type === "list") return <ListBlock key={`l-${i}`} token={t as Tokens.List} />;
        if (t.type === "text") {
          const tt = t as Tokens.Text;
          return <Text key={`t-${i}`}>{tt.tokens ? inline(tt.tokens) : tt.text}</Text>;
        }
        if (t.type === "paragraph") {
          return <Text key={`p-${i}`}>{inline((t as Tokens.Paragraph).tokens)}</Text>;
        }
        return <BlockToken key={`b-${i}`} token={t} />;
      })}
    </>
  );
}

/**
 * Render inline tokens (the children of a block) into nestable <Text> nodes.
 * Every styled span is a real <Text> with bold/italic/color/underline — no
 * syntax characters, because marked already stripped them into `raw`.
 */
function inline(tokens: Token[] | undefined): React.ReactNode {
  if (tokens === undefined) return null;
  return tokens.map((t, i) => {
    switch (t.type) {
      case "strong":
        return (
          <Text key={`in-${i}`} bold>
            {inline((t as Tokens.Strong).tokens)}
          </Text>
        );
      case "em":
        return (
          <Text key={`in-${i}`} italic>
            {inline((t as Tokens.Em).tokens)}
          </Text>
        );
      case "del":
        return (
          <Text key={`in-${i}`} strikethrough>
            {inline((t as Tokens.Del).tokens)}
          </Text>
        );
      case "codespan":
        return (
          <Text key={`in-${i}`} color="cyan">
            {(t as Tokens.Codespan).text}
          </Text>
        );
      case "link":
        return (
          <Text key={`in-${i}`} color="blue" underline>
            {inline((t as Tokens.Link).tokens)}
          </Text>
        );
      case "br":
        return <Text key={`in-${i}`}>{"\n"}</Text>;
      case "escape":
        return <Text key={`in-${i}`}>{(t as Tokens.Escape).text}</Text>;
      case "text": {
        const tt = t as Tokens.Text;
        if (tt.tokens && tt.tokens.length > 0)
          return <Text key={`in-${i}`}>{inline(tt.tokens)}</Text>;
        return <Text key={`in-${i}`}>{tt.text}</Text>;
      }
      default:
        return <Text key={`in-${i}`}>{"text" in t ? (t as { text: string }).text : ""}</Text>;
    }
  });
}
