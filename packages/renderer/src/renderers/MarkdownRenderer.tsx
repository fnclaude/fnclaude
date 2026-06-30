import { decodeHTML } from "entities";
import { Box, Text } from "ink";
import { type Token, type Tokens, marked } from "marked";
import { type JSX, useContext, useMemo } from "react";
import remend from "remend";
import { type RendererTheme, useRendererTheme } from "../theme.tsx";
import { AlertBlock, parseAlert } from "./AlertBlock.tsx";
import { CodeBlock } from "./CodeBlock.tsx";
import { TableBlock } from "./TableBlock.tsx";
import { emojify } from "./emoji.ts";
import { tokenizeGithubAutolinks } from "./github-autolink.ts";
import { GithubRepoContext } from "./github-repo-context.ts";
import {
  INTERPRETED_CONTAINERS,
  type ParsedHtmlTag,
  isInterpretedVoid,
  parseHtmlTag,
} from "./html-inline.ts";
import { kbdToGlyphs } from "./kbd-glyphs.ts";
import { osc8End, osc8Start, supportsHyperlinkOutput } from "./osc8.ts";

/** Horizontal-rule glyph run, shared by the block `hr` and inline `<hr>`. */
const HR_RULE = "─".repeat(40);

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
function headingTextProps(
  depth: number,
  theme: RendererTheme,
): {
  bold?: boolean;
  underline?: boolean;
  color?: string;
  dimColor?: boolean;
} {
  switch (depth) {
    case 1:
      return { bold: true, underline: true, color: theme.heading };
    case 2:
      return { bold: true, color: theme.heading };
    case 3:
      return { bold: true, color: theme.headingAccent };
    case 4:
      return { bold: true, color: theme.headingPlain };
    case 5:
      return { bold: true, dimColor: true };
    default:
      return { dimColor: true }; // H6+
  }
}

/** A single block-level token → its block element (or null for whitespace). */
function BlockToken({ token }: { token: Token }): JSX.Element | null {
  const theme = useRendererTheme();
  switch (token.type) {
    case "heading": {
      const h = token as Tokens.Heading;
      const props = headingTextProps(h.depth, theme);
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
          <Text {...textProps}>{inline(h.tokens, theme)}</Text>
        </Box>
      );
    }
    case "paragraph":
      return (
        <Box marginBottom={1}>
          <Text>{inline((token as Tokens.Paragraph).tokens, theme)}</Text>
        </Box>
      );
    case "text": {
      const tt = token as Tokens.Text;
      return <Text>{tt.tokens ? inline(tt.tokens, theme) : tt.text}</Text>;
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
          borderColor={theme.blockquoteBorder}
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
          <Text dimColor>{HR_RULE}</Text>
        </Box>
      );
    case "space":
      return null;
    case "table":
      return (
        <TableBlock token={token as Tokens.Table} renderInline={(toks) => inline(toks, theme)} />
      );
    case "html": {
      // Block-level raw HTML arrives as one token (the whole `<div>…</div>`),
      // not the split open/text/close stream inline HTML produces. Interpret a
      // lone void tag (`<br>`/`<hr>`); otherwise surface the literal markup in
      // the raw-markup color rather than dropping it.
      const html = (token as Tokens.HTML).text;
      const tag = parseHtmlTag(html);
      if (tag && tag.kind === "void" && tag.name === "hr") {
        return (
          <Box marginBottom={1}>
            <Text dimColor>{HR_RULE}</Text>
          </Box>
        );
      }
      if (tag && tag.kind === "void" && tag.name === "br") {
        return <Text>{"\n"}</Text>;
      }
      return (
        <Text color={theme.rawMarkup} dimColor>
          {html}
        </Text>
      );
    }
    default:
      return <Text>{"text" in token ? (token as { text: string }).text : ""}</Text>;
  }
}

function ListBlock({ token }: { token: Tokens.List }): JSX.Element {
  const theme = useRendererTheme();
  return (
    <Box flexDirection="column" marginBottom={1}>
      {token.items.map((item, i) => {
        // GFM task-list items: render a checkbox glyph instead of the bullet.
        if (item.task) {
          const checkbox = item.checked ? "☑" : "☐";
          return (
            <Box key={`li-${i}`} flexDirection="row">
              {item.checked ? (
                <Text color={theme.listMarkerChecked}>{`${checkbox} `}</Text>
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
              <Text color={theme.listMarkerOrdered}>{`${marker} `}</Text>
            ) : (
              <Text color={theme.listMarkerBullet}>{`${marker} `}</Text>
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
  const theme = useRendererTheme();
  return (
    <>
      {item.tokens.map((t, i) => {
        // The `checkbox` token is the marker already rendered as the bullet;
        // skip it so we don't produce a spurious empty element.
        if (t.type === "checkbox") return null;
        if (t.type === "list") return <ListBlock key={`l-${i}`} token={t as Tokens.List} />;
        if (t.type === "text") {
          const tt = t as Tokens.Text;
          return <Text key={`t-${i}`}>{tt.tokens ? inline(tt.tokens, theme) : tt.text}</Text>;
        }
        if (t.type === "paragraph") {
          return <Text key={`p-${i}`}>{inline((t as Tokens.Paragraph).tokens, theme)}</Text>;
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
 *
 * A grouping pass runs first: `marked` emits inline raw HTML as a SPLIT token
 * stream (`<kbd>` / `Ctrl` / `</kbd>` → three tokens), so consecutive tokens
 * between a recognized open tag and its matching close are gathered back into a
 * single styled span. See {@link renderInlineTokens}.
 */
function inline(tokens: Token[] | undefined, theme: RendererTheme): React.ReactNode {
  if (tokens === undefined) return null;
  return renderInlineTokens(tokens, theme);
}

/**
 * Walk an inline token stream, grouping split raw-HTML tokens into styled spans
 * and mapping every other token to its inline element. Non-HTML tokens go
 * through {@link renderInlineToken}.
 */
function renderInlineTokens(tokens: Token[], theme: RendererTheme): React.ReactNode {
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === "html") {
      const html = (t as Tokens.HTML).text;
      const tag = parseHtmlTag(html);
      if (tag) {
        if (tag.kind === "void" && isInterpretedVoid(tag.name)) {
          out.push(renderVoidHtml(tag.name, key++));
          i++;
          continue;
        }
        if (tag.kind === "open" && INTERPRETED_CONTAINERS.has(tag.name)) {
          const close = findMatchingClose(tokens, i, tag.name);
          if (close !== -1) {
            const inner = tokens.slice(i + 1, close);
            out.push(renderHtmlContainer(tag, inner, key++, theme));
            i = close + 1;
            continue;
          }
        }
      }
      // Any tag we don't interpret — unknown pseudo-XML (`<Foo>`), an
      // allowlisted-but-no-analog tag (`<div>`), a self-closing `<img/>`, a
      // stray close tag, or an open tag with no matching close — surfaces as
      // colored literal markup rather than being silently dropped.
      out.push(rawMarkup(html, key++, theme));
      i++;
      continue;
    }
    out.push(renderInlineToken(t, key++, theme));
    i++;
  }
  return out;
}

/** Literal raw HTML text, colored so it's visibly unhandled markup. */
function rawMarkup(text: string, key: number, theme: RendererTheme): React.ReactNode {
  return (
    <Text key={`raw-${key}`} color={theme.rawMarkup} dimColor>
      {text}
    </Text>
  );
}

/** Interpret a void HTML tag (`<br>` → newline, `<hr>` → rule). */
function renderVoidHtml(name: string, key: number): React.ReactNode {
  if (name === "br") return <Text key={`br-${key}`}>{"\n"}</Text>;
  // hr
  return (
    <Text key={`hr-${key}`} dimColor>
      {`\n${HR_RULE}\n`}
    </Text>
  );
}

/** Find the index of the close tag matching the open at `openIdx`, or -1. */
function findMatchingClose(tokens: Token[], openIdx: number, name: string): number {
  let depth = 0;
  for (let j = openIdx + 1; j < tokens.length; j++) {
    const tok = tokens[j];
    if (tok.type !== "html") continue;
    const tag = parseHtmlTag((tok as Tokens.HTML).text);
    if (!tag || tag.name !== name) continue;
    if (tag.kind === "open") depth++;
    else if (tag.kind === "close") {
      if (depth === 0) return j;
      depth--;
    }
  }
  return -1;
}

/** Concatenate the plain text of a token run (used for `<kbd>` key parsing). */
function plainText(tokens: Token[]): string {
  return tokens.map((t) => ("text" in t ? (t as { text: string }).text : t.raw)).join("");
}

/** Render an interpreted raw-HTML container by wrapping its grouped children. */
function renderHtmlContainer(
  tag: ParsedHtmlTag,
  inner: Token[],
  key: number,
  theme: RendererTheme,
): React.ReactNode {
  const k = `html-${key}`;
  switch (tag.name) {
    case "b":
    case "strong":
      return (
        <Text key={k} bold>
          {renderInlineTokens(inner, theme)}
        </Text>
      );
    case "i":
    case "em":
      return (
        <Text key={k} italic>
          {renderInlineTokens(inner, theme)}
        </Text>
      );
    case "s":
    case "strike":
    case "del":
      return (
        <Text key={k} strikethrough>
          {renderInlineTokens(inner, theme)}
        </Text>
      );
    case "ins":
      return (
        <Text key={k} underline>
          {renderInlineTokens(inner, theme)}
        </Text>
      );
    case "code":
    case "tt":
    case "samp":
    case "var":
      return (
        <Text key={k} color={theme.inlineCode}>
          {renderInlineTokens(inner, theme)}
        </Text>
      );
    case "q":
      return (
        <Text key={k}>
          {'"'}
          {renderInlineTokens(inner, theme)}
          {'"'}
        </Text>
      );
    case "mark":
      return (
        <Text key={k} inverse>
          {renderInlineTokens(inner, theme)}
        </Text>
      );
    case "kbd":
      // Render keys as NerdFont glyph(s). Unknown keys fall back to their
      // literal text inside the same kbd style, so nothing crashes or is lost.
      return (
        <Text key={k} bold color={theme.kbd}>
          {kbdToGlyphs(plainText(inner))}
        </Text>
      );
    case "sub":
      // ASCII prefix (Tom's call): H<sub>2</sub>O → H_2O, not a Unicode glyph.
      return (
        <Text key={k}>
          {"_"}
          {renderInlineTokens(inner, theme)}
        </Text>
      );
    case "sup":
      return (
        <Text key={k}>
          {"^"}
          {renderInlineTokens(inner, theme)}
        </Text>
      );
    case "a":
      return (
        <Link key={k} href={tag.href ?? ""}>
          {renderInlineTokens(inner, theme)}
        </Link>
      );
    default:
      return rawMarkup(tag.raw, key, theme);
  }
}

/**
 * Single source of truth for link rendering — used by markdown `link` tokens,
 * raw `<a href>` tags, and GitHub autolinks. The underline policy lives here
 * and nowhere else.
 *
 * Only http/https/mailto hrefs are clickable. Those always style blue+underline
 * (so a link reads as a link whether or not the terminal can make it
 * clickable) and additionally wrap in an OSC 8 hyperlink when the terminal
 * supports one — making `[text](url)` clickable even when the visible text
 * isn't the URL (the terminal's own URL matcher can't help there). The BEL-form
 * OSC bytes tokenize as zero-width (see osc8.ts) so they don't perturb table
 * cell-width measurement. Non-clickable hrefs (anchors, relative paths) render
 * plain so they don't look interactive when they aren't.
 */
function Link({ href, children }: { href: string; children: React.ReactNode }): JSX.Element {
  const theme = useRendererTheme();
  if (!/^(https?:\/\/|mailto:)/.test(href)) {
    return <Text>{children}</Text>;
  }
  if (supportsHyperlinkOutput()) {
    return (
      <Text color={theme.link} underline>
        {osc8Start(href)}
        {children}
        {osc8End()}
      </Text>
    );
  }
  return (
    <Text color={theme.link} underline>
      {children}
    </Text>
  );
}

/** Map a single non-HTML inline token to its Ink element. */
function renderInlineToken(t: Token, key: number, theme: RendererTheme): React.ReactNode {
  const i = key;
  switch (t.type) {
    case "strong":
      return (
        <Text key={`in-${i}`} bold>
          {inline((t as Tokens.Strong).tokens, theme)}
        </Text>
      );
    case "em":
      return (
        <Text key={`in-${i}`} italic>
          {inline((t as Tokens.Em).tokens, theme)}
        </Text>
      );
    case "del":
      return (
        <Text key={`in-${i}`} strikethrough>
          {inline((t as Tokens.Del).tokens, theme)}
        </Text>
      );
    case "codespan":
      return (
        <Text key={`in-${i}`} color={theme.inlineCode}>
          {(t as Tokens.Codespan).text}
        </Text>
      );
    case "link": {
      const link = t as Tokens.Link;
      return (
        <Link key={`in-${i}`} href={link.href ?? ""}>
          {inline(link.tokens, theme)}
        </Link>
      );
    }
    case "br":
      return <Text key={`in-${i}`}>{"\n"}</Text>;
    case "escape":
      return <Text key={`in-${i}`}>{(t as Tokens.Escape).text}</Text>;
    case "text": {
      const tt = t as Tokens.Text;
      if (tt.tokens && tt.tokens.length > 0)
        return <Text key={`in-${i}`}>{inline(tt.tokens, theme)}</Text>;
      // marked leaves HTML entities as-is in GFM mode; AutolinkedText decodes
      // them (&copy; → ©, …) and links any GitHub @mention/#ref/SHA forms.
      // Codespans never reach here, so code is never autolinked.
      return <AutolinkedText key={`in-${i}`} text={tt.text} />;
    }
    default:
      return <Text key={`in-${i}`}>{"text" in t ? (t as { text: string }).text : ""}</Text>;
  }
}

/**
 * Render a leaf text run, decoding HTML entities and linking GitHub autolink
 * forms (@mentions, #refs, GH-refs, commit SHAs) against the ambient repo
 * context. Linked segments route through the shared {@link Link} component, so
 * they style blue+underline (and wrap in an OSC 8 hyperlink when supported)
 * identically to markdown links and raw `<a href>` tags. Plain http/https/mailto
 * links are unaffected — they're handled by the `link` case, never reaching here.
 */
function AutolinkedText({ text }: { text: string }): JSX.Element {
  const repo = useContext(GithubRepoContext);
  const decoded = decodeHTML(text);
  const segments = tokenizeGithubAutolinks(decoded, repo);
  return (
    <>
      {segments.map((seg, i) => {
        // Non-link plain text: render emoji shortcodes (`:rocket:` → 🚀).
        // Linked segments are left untouched so we never emojify inside URLs or
        // autolink display text. Codespans/code blocks never reach this path.
        if (seg.url === undefined) return emojify(seg.text);
        return (
          <Link key={`gl-${i}`} href={seg.url}>
            {seg.text}
          </Link>
        );
      })}
    </>
  );
}
