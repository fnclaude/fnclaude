import { afterEach, describe, expect, test } from "bun:test";
import {
  osc8,
  osc8End,
  osc8Start,
  setHyperlinkSupportOverride,
  supportsHyperlinkOutput,
} from "./osc8";

describe("osc8", () => {
  test("osc8 wraps text+url in the exact BEL-terminator form", () => {
    expect(osc8("https://x.dev", "click")).toBe("\x1b]8;;https://x.dev\x07click\x1b]8;;\x07");
  });

  test("osc8 uses BEL (\\x07), not the ESC-backslash (ST) terminator", () => {
    const seq = osc8("https://x.dev", "click");
    expect(seq).toContain("\x07");
    expect(seq).not.toContain("\x1b\\"); // ST form would break Ink's tokenizer
  });

  test("osc8Start / osc8End compose to the same sequence as osc8", () => {
    expect(`${osc8Start("u")}txt${osc8End()}`).toBe(osc8("u", "txt"));
  });

  describe("support detection seam", () => {
    afterEach(() => setHyperlinkSupportOverride(undefined));

    test("override forces support on and off", () => {
      setHyperlinkSupportOverride(true);
      expect(supportsHyperlinkOutput()).toBe(true);
      setHyperlinkSupportOverride(false);
      expect(supportsHyperlinkOutput()).toBe(false);
    });

    test("clearing the override restores real detection (false in the test stream)", () => {
      setHyperlinkSupportOverride(true);
      setHyperlinkSupportOverride(undefined);
      expect(supportsHyperlinkOutput()).toBe(false);
    });
  });
});
