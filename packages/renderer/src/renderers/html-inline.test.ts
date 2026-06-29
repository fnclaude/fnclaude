import { describe, expect, test } from "bun:test";
import { INTERPRETED_CONTAINERS, isInterpretedVoid, parseHtmlTag } from "./html-inline";

describe("parseHtmlTag", () => {
  test("open container tag", () => {
    expect(parseHtmlTag("<strong>")).toEqual({ kind: "open", name: "strong", raw: "<strong>" });
  });

  test("close tag", () => {
    expect(parseHtmlTag("</strong>")).toEqual({ kind: "close", name: "strong", raw: "</strong>" });
  });

  test("void tags (br/hr) and self-closing", () => {
    expect(parseHtmlTag("<br>")?.kind).toBe("void");
    expect(parseHtmlTag("<hr>")?.kind).toBe("void");
    expect(parseHtmlTag("<img/>")?.kind).toBe("void");
  });

  test("lowercases name but preserves raw casing", () => {
    const tag = parseHtmlTag("<Foo>");
    expect(tag?.name).toBe("foo");
    expect(tag?.raw).toBe("<Foo>");
  });

  test("extracts href (double and single quotes)", () => {
    expect(parseHtmlTag('<a href="https://x.com">')?.href).toBe("https://x.com");
    expect(parseHtmlTag("<a href='https://y.com'>")?.href).toBe("https://y.com");
  });

  test("non-tag text → null", () => {
    expect(parseHtmlTag("not a tag")).toBeNull();
    expect(parseHtmlTag("a < b")).toBeNull();
  });
});

describe("classification sets", () => {
  test("INTERPRETED_CONTAINERS covers the styled subset", () => {
    for (const name of [
      "strong",
      "em",
      "del",
      "ins",
      "code",
      "q",
      "mark",
      "kbd",
      "sub",
      "sup",
      "a",
    ]) {
      expect(INTERPRETED_CONTAINERS.has(name)).toBe(true);
    }
    expect(INTERPRETED_CONTAINERS.has("div")).toBe(false);
    expect(INTERPRETED_CONTAINERS.has("foo")).toBe(false);
  });

  test("isInterpretedVoid only br/hr", () => {
    expect(isInterpretedVoid("br")).toBe(true);
    expect(isInterpretedVoid("hr")).toBe(true);
    expect(isInterpretedVoid("img")).toBe(false);
  });
});
