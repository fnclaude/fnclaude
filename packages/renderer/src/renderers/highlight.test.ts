import { describe, expect, test } from "bun:test";
import { highlightCode } from "./highlight.ts";

const pythonSnippet = `def greet(name):
    print(f"Hello, {name}")

greet("world")
`;

describe("highlightCode", () => {
  test("known language: returns ANSI-coloured string containing identifiers", () => {
    const result = highlightCode(pythonSnippet, "python");
    // Must contain ANSI escape sequences
    expect(result).toMatch(/\x1B\[/);
    // Key identifiers must survive through the coloring
    expect(result).toContain("greet");
    expect(result).toContain("print");
    expect(result).toContain("Hello");
  });

  test("unknown language: returns code unchanged, does not throw", () => {
    const code = "foo bar baz";
    const result = highlightCode(code, "not-a-real-language-xyz");
    expect(result).toBe(code);
  });

  test("missing language: returns code unchanged", () => {
    const code = "some code without lang";
    expect(highlightCode(code)).toBe(code);
    expect(highlightCode(code, undefined)).toBe(code);
  });

  test("empty string with known language: does not throw", () => {
    expect(() => highlightCode("", "javascript")).not.toThrow();
  });
});
