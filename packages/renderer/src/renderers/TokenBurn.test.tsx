import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { TokenUsage } from "../types/events";
import { TokenBurn } from "./TokenBurn";

describe("TokenBurn", () => {
  test("renders input/output counts", () => {
    const usage: TokenUsage = { input_tokens: 12, output_tokens: 7 };
    const { lastFrame } = render(<TokenBurn usage={usage} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("12");
    expect(frame).toContain("7");
    expect(frame).toContain("in");
    expect(frame).toContain("out");
  });

  test("renders dim (ANSI faint)", () => {
    const usage: TokenUsage = { input_tokens: 12, output_tokens: 7 };
    const { lastFrame } = render(<TokenBurn usage={usage} />);
    expect(lastFrame() ?? "").toMatch(/\x1B\[2m/);
  });

  test("k-abbreviates counts >= 1000", () => {
    const usage: TokenUsage = { input_tokens: 12345, output_tokens: 2000 };
    const { lastFrame } = render(<TokenBurn usage={usage} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("12.3k");
    expect(frame).toContain("2.0k");
    expect(frame).not.toContain("12345");
  });

  test("leaves sub-1000 counts unabbreviated", () => {
    const usage: TokenUsage = { input_tokens: 999, output_tokens: 1 };
    const { lastFrame } = render(<TokenBurn usage={usage} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("999");
    expect(frame).not.toContain("k");
  });

  test("renders cache section when cache fields present and non-zero", () => {
    const usage: TokenUsage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 3000,
      cache_read_input_tokens: 9000,
    };
    const { lastFrame } = render(<TokenBurn usage={usage} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("cache");
    expect(frame).toContain("3.0k");
    expect(frame).toContain("9.0k");
  });

  test("omits cache section when both cache fields absent", () => {
    const usage: TokenUsage = { input_tokens: 100, output_tokens: 50 };
    const { lastFrame } = render(<TokenBurn usage={usage} />);
    expect(lastFrame() ?? "").not.toContain("cache");
  });

  test("omits cache section when both cache fields zero", () => {
    const usage: TokenUsage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    const { lastFrame } = render(<TokenBurn usage={usage} />);
    expect(lastFrame() ?? "").not.toContain("cache");
  });

  test("renders cache section when only one cache field is non-zero", () => {
    const usage: TokenUsage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 4000,
    };
    const { lastFrame } = render(<TokenBurn usage={usage} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("cache");
    expect(frame).toContain("4.0k");
  });
});
