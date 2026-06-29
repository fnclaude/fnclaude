import { decodeHTML } from "entities";
import { Box, Text } from "ink";
import { type Token, type Tokens, marked } from "marked";
import { useContext, useMemo } from "react";
import remend from "remend";
import { AlertBlock, parseAlert } from "./AlertBlock.tsx";
import { CodeBlock } from "./CodeBlock.tsx";
import { TableBlock } from "./TableBlock.tsx";
import { tokenizeGithubAutolinks } from "./github-autolink.ts";
import { GithubRepoContext } from "./github-repo-context.ts";
import { osc8End, osc8Start, supportsHyperlinkOutput } from "./osc8.ts";

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
  // Memoize the heal+lex on `text` so a top-level re-render (e.g. every
  // keystroke mutating the draft) doesn't re-parse already-committed
  // transcript markdown. Parse cost then stays flat per keystroke instead
  // of scaling with conversation length.
  const tokens = useMemo(() => marked.lexer(remend(text)), [text]);
  return (
    <Box flexDirection="column">
      {tokens.map((token, i) => (
        <BlockToken key={`b-${i}`} token={token} />
      ))}
    </Box>
  );
}

/** Per-depth heading style: H1 most prominent, H6 least. */
function headingTextProps(depth: number): {
  bold?: boolean;
  underline?: boolean;
  color?: string;
  dimColor?: boolean;
} {
  switch (depth) {
    case 1:
      return { bold: true, underline: true, color: "cyan" };
    case 2:
      return { bold: true, color: "cyan" };
    case 3:
      return { bold: true, color: "blue" };
    case 4:
      return { bold: true, color: "white" };
    case 5:
      return { bold: true, dimColor: true };
    default:
      return { dimColor: true }; // H6+
  }
}

/** A single block-level token → its block element (or null for whitespace). */
function BlockToken({ token }: { token: Token }): JSX.Element | null {
  switch (token.type) {
    case "heading": {
      const h = token as Tokens.Heading;
      const props = headingTextProps(h.depth);
      // exactOptionalPropertyTypes forbids passing `undefined` for typed
      // optional props, so spread only the keys that are actually set.
      const textProps = {
        ...(props.bold !== undefined ? { bold: props.bold } : {}),
        ...(props.underline !== undefined ? { underline: props.underline } : {}),
        ...(props.color !== undefined ? { color: props.color } : {}),
        ...(props.dimColor !== undefined ? { dimColor: props.dimColor } : {}),
      };
      return (
        <Box marginBottom={1}>
          <Text {...textProps}>{inline(h.tokens)}</Text>
        </Box>
      );
    }
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
      return <CodeBlock code={code.text} lang={code.lang ?? undefined} />;
    }
    case "blockquote": {
      const bq = token as Tokens.Blockquote;
      const alert = parseAlert(bq);
      if (alert) {
        return (
          <AlertBlock
            kind={alert.kind}
            bodyTokens={alert.bodyTokens}
            renderChildren={(toks) => toks.map((t, i) => <BlockToken key={i} token={t} />)}
          />
        );
      }
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
    case "table":
      return <TableBlock token={token as Tokens.Table} renderInline={(toks) => inline(toks)} />;
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
        // GFM task-list items: render a checkbox glyph instead of the bullet.
        if (item.task) {
          const checkbox = item.checked ? "☑" : "☐";
          return (
            <Box key={`li-${i}`} flexDirection="row">
              {item.checked ? (
                <Text color="green">{`${checkbox} `}</Text>
              ) : (
                <Text>{`${checkbox} `}</Text>
              )}
              <Box flexDirection="column">
                <ListItemBody item={item} />
              </Box>
            </Box>
          );
        }
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
        // The `checkbox` token is the marker already rendered as the bullet;
        // skip it so we don't produce a spurious empty element.
        if (t.type === "checkbox") return null;
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
      case "link": {
        const link = t as Tokens.Link;
        const href = link.href ?? "";
        // Style http/https/mailto links blue+underline. When the terminal
        // supports OSC 8 hyperlinks, wrap the (possibly titled) display text in
        // an OSC 8 sequence so `[text](url)` is clickable even when the visible
        // text isn't the URL — the terminal's URL auto-matcher can't handle
        // those. The BEL-form OSC bytes tokenize as zero-width (see osc8.ts),
        // so they don't perturb table cell-width measurement.
        // When hyperlinks aren't supported, fall back to plain blue+underline
        // and rely on the terminal's own URL matcher.
        // Anchors (#id), relative paths, and other non-clickable hrefs render
        // plain so they don't look interactive when they aren't.
        if (/^(https?:\/\/|mailto:)/.test(href)) {
          if (supportsHyperlinkOutput()) {
            return (
              <Text key={`in-${i}`} color="blue" underline>
                {osc8Start(href)}
                {inline(link.tokens)}
                {osc8End()}
              </Text>
            );
          }
          return (
            <Text key={`in-${i}`} color="blue" underline>
              {inline(link.tokens)}
            </Text>
          );
        }
        // Non-clickable link: render its text without any link styling.
        return <Text key={`in-${i}`}>{inline(link.tokens)}</Text>;
      }
      case "br":
        return <Text key={`in-${i}`}>{"\n"}</Text>;
      case "escape":
        return <Text key={`in-${i}`}>{(t as Tokens.Escape).text}</Text>;
      case "text": {
        const tt = t as Tokens.Text;
        if (tt.tokens && tt.tokens.length > 0)
          return <Text key={`in-${i}`}>{inline(tt.tokens)}</Text>;
        // marked leaves HTML entities as-is in GFM mode; AutolinkedText decodes
        // them (&copy; → ©, …) and links any GitHub @mention/#ref/SHA forms.
        // Codespans never reach here, so code is never autolinked.
        return <AutolinkedText key={`in-${i}`} text={tt.text} />;
      }
      default:
        return <Text key={`in-${i}`}>{"text" in t ? (t as { text: string }).text : ""}</Text>;
    }
  });
}

/**
 * Render a leaf text run, decoding HTML entities and linking GitHub autolink
 * forms (@mentions, #refs, GH-refs, commit SHAs) against the ambient repo
 * context. Each linked segment styles blue+underline and, when the terminal
 * supports OSC 8, wraps in a clickable hyperlink — consistent with how titled
 * markdown links render. When hyperlinks aren't supported the link is colored
 * but NOT underlined (visible, not clickable). Plain http/https/mailto links
 * are unaffected — they're handled by the `link` case, never reaching here.
 */
function AutolinkedText({ text }: { text: string }): JSX.Element {
  const repo = useContext(GithubRepoContext);
  const decoded = decodeHTML(text);
  const segments = tokenizeGithubAutolinks(decoded, repo);
  const linkable = supportsHyperlinkOutput();
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.url === undefined) return seg.text;
        if (linkable) {
          return (
            <Text key={`gl-${i}`} color="blue" underline>
              {osc8Start(seg.url)}
              {seg.text}
              {osc8End()}
            </Text>
          );
        }
        return (
          <Text key={`gl-${i}`} color="blue">
            {seg.text}
          </Text>
        );
      })}
    </>
  );
}
