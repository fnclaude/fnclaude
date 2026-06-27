import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { type Token, type Tokens, marked } from "marked";
import { AlertBlock, parseAlert, type AlertKind } from "./AlertBlock.tsx";

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
    expect(result!.kind).toBe("warning");
    // Marker must be absent from body text
    const bodyText = result!.bodyTokens
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
    expect(result!.kind).toBe("note");
  });

  test("[!TIP] returns kind 'tip'", () => {
    const tokens = marked.lexer("> [!TIP]\n> use this shortcut");
    const bq = tokens[0] as Tokens.Blockquote;
    const result = parseAlert(bq);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("tip");
  });

  test("[!IMPORTANT] returns kind 'important'", () => {
    const tokens = marked.lexer("> [!IMPORTANT]\n> do not skip");
    const bq = tokens[0] as Tokens.Blockquote;
    const result = parseAlert(bq);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("important");
  });

  test("[!CAUTION] returns kind 'caution'", () => {
    const tokens = marked.lexer("> [!CAUTION]\n> danger zone");
    const bq = tokens[0] as Tokens.Blockquote;
    const result = parseAlert(bq);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("caution");
  });

  test("case-insensitive: [!warning] is accepted", () => {
    const tokens = marked.lexer("> [!warning]\n> lower case");
    const bq = tokens[0] as Tokens.Blockquote;
    const result = parseAlert(bq);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("warning");
  });

  test("multi-paragraph alert: body tokens include subsequent paragraphs", () => {
    const tokens = marked.lexer("> [!NOTE]\n> First line\n>\n> Second paragraph");
    const bq = tokens[0] as Tokens.Blockquote;
    const result = parseAlert(bq);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("note");
    const bodyText = result!.bodyTokens
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
  return tokens.map((t, i) => {
    if (t.type === "paragraph") {
      return <Text key={i}>{(t as Tokens.Paragraph).text}</Text>;
    }
    return null;
  });
}

describe("AlertBlock", () => {
  test("Warning: renders 'Warning' title, no literal '[!WARNING]'", () => {
    const tokens = marked.lexer("> [!WARNING]\n> be careful");
    const bq = tokens[0] as Tokens.Blockquote;
    const result = parseAlert(bq)!;
    const { lastFrame } = render(
      <AlertBlock
        kind={result.kind}
        bodyTokens={result.bodyTokens}
        renderChildren={simpleRenderChildren}
      />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Warning");
    expect(frame).toContain("be careful");
    expect(frame).not.toContain("[!WARNING]");
    // Accent color SGR escape present
    expect(frame).toMatch(/\x1B\[/);
  });

  test("Note: renders 'Note' title with blue color SGR", () => {
    const tokens = marked.lexer("> [!NOTE]\n> pay attention");
    const bq = tokens[0] as Tokens.Blockquote;
    const result = parseAlert(bq)!;
    const { lastFrame } = render(
      <AlertBlock
        kind={result.kind}
        bodyTokens={result.bodyTokens}
        renderChildren={simpleRenderChildren}
      />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Note");
    expect(frame).toContain("pay attention");
    expect(frame).not.toContain("[!NOTE]");
    expect(frame).toMatch(/\x1B\[/);
  });

  test("Tip: renders 'Tip' title", () => {
    const tokens = marked.lexer("> [!TIP]\n> use this shortcut");
    const bq = tokens[0] as Tokens.Blockquote;
    const result = parseAlert(bq)!;
    const { lastFrame } = render(
      <AlertBlock
        kind={result.kind}
        bodyTokens={result.bodyTokens}
        renderChildren={simpleRenderChildren}
      />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Tip");
    expect(frame).not.toContain("[!TIP]");
  });

  test("Important: renders 'Important' title", () => {
    const tokens = marked.lexer("> [!IMPORTANT]\n> do not skip");
    const bq = tokens[0] as Tokens.Blockquote;
    const result = parseAlert(bq)!;
    const { lastFrame } = render(
      <AlertBlock
        kind={result.kind}
        bodyTokens={result.bodyTokens}
        renderChildren={simpleRenderChildren}
      />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Important");
    expect(frame).not.toContain("[!IMPORTANT]");
  });

  test("Caution: renders 'Caution' title", () => {
    const tokens = marked.lexer("> [!CAUTION]\n> danger zone");
    const bq = tokens[0] as Tokens.Blockquote;
    const result = parseAlert(bq)!;
    const { lastFrame } = render(
      <AlertBlock
        kind={result.kind}
        bodyTokens={result.bodyTokens}
        renderChildren={simpleRenderChildren}
      />
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Caution");
    expect(frame).not.toContain("[!CAUTION]");
  });

  test("direct AlertBlock: all kinds render their Title-Case label", () => {
    const kinds: AlertKind[] = ["note", "tip", "important", "warning", "caution"];
    const expectedLabels = ["Note", "Tip", "Important", "Warning", "Caution"];
    for (let i = 0; i < kinds.length; i++) {
      const { lastFrame } = render(
        <AlertBlock
          kind={kinds[i]}
          bodyTokens={[]}
          renderChildren={() => null}
        />
      );
      const frame = lastFrame() ?? "";
      expect(frame).toContain(expectedLabels[i]);
    }
  });
});
