import { describe, expect, test } from "bun:test";
import {
  KBD_ALPHA,
  KBD_ARROW,
  KBD_FKEY,
  KBD_MODIFIER,
  KBD_NAMED,
  KBD_NUMERIC,
  KBD_SYMBOL,
  kbdToGlyphs,
  mapKbdToken,
} from "./kbd-glyphs";

describe("mapKbdToken", () => {
  test("modifiers (ctrl/alt/shift/super) → apple_keyboard glyphs", () => {
    expect(mapKbdToken("Ctrl")).toBe(KBD_MODIFIER.control);
    expect(mapKbdToken("alt")).toBe(KBD_MODIFIER.option);
    expect(mapKbdToken("Shift")).toBe(KBD_MODIFIER.shift);
    expect(mapKbdToken("super")).toBe(KBD_MODIFIER.command);
    expect(mapKbdToken("cmd")).toBe(KBD_MODIFIER.command);
  });

  test("single letters and digits", () => {
    expect(mapKbdToken("C")).toBe(KBD_ALPHA.c);
    expect(mapKbdToken("z")).toBe(KBD_ALPHA.z);
    expect(mapKbdToken("5")).toBe(KBD_NUMERIC["5"]);
  });

  test("named keys, arrows, f-keys, symbols", () => {
    expect(mapKbdToken("Enter")).toBe(KBD_NAMED.enter);
    expect(mapKbdToken("Esc")).toBe(KBD_NAMED.esc);
    expect(mapKbdToken("Up")).toBe(KBD_ARROW.up);
    expect(mapKbdToken("ArrowDown")).toBe(KBD_ARROW.down);
    expect(mapKbdToken("F5")).toBe(KBD_FKEY.f5);
    expect(mapKbdToken("+")).toBe(KBD_SYMBOL["+"]);
  });

  test("unrecognized token → undefined", () => {
    expect(mapKbdToken("Frobnicate")).toBeUndefined();
    expect(mapKbdToken("F13")).toBeUndefined();
    expect(mapKbdToken("")).toBeUndefined();
  });
});

describe("kbdToGlyphs", () => {
  test("chord 'Ctrl+C' → one glyph per recognized token", () => {
    expect(kbdToGlyphs("Ctrl+C")).toBe(`${KBD_MODIFIER.control}${KBD_ALPHA.c}`);
  });

  test("spacing around '+' is tolerated", () => {
    expect(kbdToGlyphs("Ctrl + Shift + K")).toBe(
      `${KBD_MODIFIER.control}${KBD_MODIFIER.shift}${KBD_ALPHA.k}`,
    );
  });

  test("unknown token falls back to its literal text", () => {
    expect(kbdToGlyphs("Frobnicate")).toBe("Frobnicate");
    expect(kbdToGlyphs("Ctrl+Frob")).toBe(`${KBD_MODIFIER.control}Frob`);
  });
});
