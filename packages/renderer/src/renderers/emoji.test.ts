import { describe, expect, test } from "bun:test";
import { emojify } from "./emoji.ts";

describe("emojify", () => {
  test("replaces a standard shortcode with its Unicode glyph", () => {
    expect(emojify("ship it :rocket:")).toBe("ship it 🚀");
  });

  test("replaces a GitHub-custom shortcode with a glyph", () => {
    // `:shipit:` is an image-only emoji on github.com; we render the closest
    // Unicode approximation so it doesn't leak as literal text.
    expect(emojify(":shipit:")).not.toBe(":shipit:");
    expect(emojify(":shipit:")).not.toContain(":shipit:");
  });

  test("leaves unknown shortcodes literal", () => {
    expect(emojify("a :notareal: code")).toBe("a :notareal: code");
  });

  test("handles +1 / -1 shortcodes", () => {
    expect(emojify(":+1: :-1:")).toBe("👍 👎");
  });

  test("replaces multiple adjacent shortcodes", () => {
    expect(emojify(":rocket::rocket:")).toBe("🚀🚀");
  });

  test("is case-sensitive like GitHub (uppercase stays literal)", () => {
    expect(emojify(":Rocket:")).toBe(":Rocket:");
  });

  test("leaves text with no shortcodes untouched", () => {
    expect(emojify("plain text, no colons")).toBe("plain text, no colons");
  });
});
