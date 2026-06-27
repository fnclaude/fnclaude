import { describe, expect, test } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { type Token, type Tokens, marked } from "marked";
import { AlertBlock, type AlertKind, parseAlert } from "./AlertBlock.tsx";

// ---------------------------------------------------------------------------
// parseAlert — unit tests
// ---------------------------------------------------------------------------

describe("parseAlert", () => {
  test("returns null for a plain blockquote", () => {
    const tokens = marked.lexer("> just a regular quote");
    const bq = tokens[0] as Tokens.Blockquote;
    expect(parseAlert(bq)).toBeNull();
  });

  test("[!WARNING] returns kind 'warning' and strips the marker", () => {
    const tokens = marked.lexer("> [!WARNING]\n> be careful");
    const bq = tokens[0] as Tokens.Blockquote;
    const result = parseAlert(bq);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("warning");
    // Marker must be absent from body text
    const bodyText = result?.bodyTokens
      .map((t) => ("text" in t ? (t as { text: string }).text : ""))
      .join(" ");
    expect(bodyText).not.toMatch(/\[!WARNING\]/i);
    expect(bodyText).toContain("be careful");
  });

  test("[!NOTE] returns kind 'note'", () => {
    const tokens = marked.lexer("> [!NOTE]\n> pay attention");
    const bq = tokens[0] as Tokens.Blockquote;
    const result = parseAlert(bq);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("note");
  });

  test("[!TIP] returns kind 'tip'", () => {
    const tokens = marked.lexer("> [!TIP]\n> use this shortcut");
    const bq = tokens[0] as Tokens.Blockquote;
    const result = parseAlert(bq);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("tip");
  });

  test("[!IMPORTANT] returns kind 'important'", () => {
    const tokens = marked.lexer("> [!IMPORTANT]\n> do not skip");
    const bq = tokens[0] as Tokens.Blockquote;
    const result = parseAlert(bq);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("important");
  });

  test("[!CAUTION] returns kind 'caution'", () => {
    const tokens = marked.lexer("> [!CAUTION]\n> danger zone");
    const bq = tokens[0] as Tokens.Blockquote;
    const result = parseAlert(bq);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("caution");
  });

  test("case-insensitive: [!warning] is accepted", () => {
    const tokens = marked.lexer("> [!warning]\n> lower case");
    const bq = tokens[0] as Tokens.Blockquote;
    const result = parseAlert(bq);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("warning");
  });

  test("multi-paragraph alert: body tokens include subsequent paragraphs", () => {
    const tokens = marked.lexer("> [!NOTE]\n> First line\n>\n> Second paragraph");
    const bq = tokens[0] as Tokens.Blockquote;
    const result = parseAlert(bq);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("note");
    const bodyText = result?.bodyTokens
      .filter((t) => t.type !== "space")
      .map((t) => ("text" in t ? (t as { text: string }).text : ""))
      .join(" ");
    expect(bodyText).toContain("First line");
    expect(bodyText).toContain("Second paragraph");
  });
});

// ---------------------------------------------------------------------------
// AlertBlock — rendering tests
// ---------------------------------------------------------------------------

/** Minimal renderChildren: joins paragraph text into a single <Text>. */
function simpleRenderChildren(tokens: Token[]): React.ReactNode {
  return tokens.map((t) => {
    if (t.type === "paragraph") {
      const para = t as Tokens.Paragraph;
      // Use paragraph text as key — stable and unique within a single alert body
      return <Text key={para.text}>{para.text}</Text>;
    }
    return null;
  });
}

/** Parse a known-good alert blockquote and assert it's non-null. */
function parseKnownAlert(md: string): ReturnType<typeof parseAlert> & object {
  const tokens = marked.lexer(md);
  const bq = tokens[0] as Tokens.Blockquote;
  const result = parseAlert(bq);
  if (!result) throw new Error(`Expected alert from: ${md}`);
  return result;
}

describe("AlertBlock", () => {
  test("Warning: renders 'Warning' title, no literal '[!WARNING]'", () => {
    const result = parseKnownAlert("> [!WARNING]\n> be careful");
    const { lastFrame } = render(
      <AlertBlock
        kind={result.kind}
        bodyTokens={result.bodyTokens}
        renderChildren={simpleRenderChildren}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Warning");
    expect(frame).toContain("be careful");
    expect(frame).not.toContain("[!WARNING]");
    // Accent color SGR escape present
    expect(frame).toMatch(/\x1B\[/);
  });

  test("Note: renders 'Note' title with blue color SGR", () => {
    const result = parseKnownAlert("> [!NOTE]\n> pay attention");
    const { lastFrame } = render(
      <AlertBlock
        kind={result.kind}
        bodyTokens={result.bodyTokens}
        renderChildren={simpleRenderChildren}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Note");
    expect(frame).toContain("pay attention");
    expect(frame).not.toContain("[!NOTE]");
    expect(frame).toMatch(/\x1B\[/);
  });

  test("Tip: renders 'Tip' title", () => {
    const result = parseKnownAlert("> [!TIP]\n> use this shortcut");
    const { lastFrame } = render(
      <AlertBlock
        kind={result.kind}
        bodyTokens={result.bodyTokens}
        renderChildren={simpleRenderChildren}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Tip");
    expect(frame).not.toContain("[!TIP]");
  });

  test("Important: renders 'Important' title", () => {
    const result = parseKnownAlert("> [!IMPORTANT]\n> do not skip");
    const { lastFrame } = render(
      <AlertBlock
        kind={result.kind}
        bodyTokens={result.bodyTokens}
        renderChildren={simpleRenderChildren}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Important");
    expect(frame).not.toContain("[!IMPORTANT]");
  });

  test("Caution: renders 'Caution' title", () => {
    const result = parseKnownAlert("> [!CAUTION]\n> danger zone");
    const { lastFrame } = render(
      <AlertBlock
        kind={result.kind}
        bodyTokens={result.bodyTokens}
        renderChildren={simpleRenderChildren}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Caution");
    expect(frame).not.toContain("[!CAUTION]");
  });

  test("direct AlertBlock: all kinds render their Title-Case label", () => {
    const cases: Array<[AlertKind, string]> = [
      ["note", "Note"],
      ["tip", "Tip"],
      ["important", "Important"],
      ["warning", "Warning"],
      ["caution", "Caution"],
    ];
    for (const [kind, label] of cases) {
      const { lastFrame } = render(
        <AlertBlock kind={kind} bodyTokens={[]} renderChildren={() => null} />,
      );
      const frame = lastFrame() ?? "";
      expect(frame).toContain(label);
    }
  });
});
