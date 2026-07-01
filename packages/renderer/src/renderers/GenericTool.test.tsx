import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { Visibility } from "../types/events";
import { GenericTool, coerceStructured, salientArg } from "./GenericTool";
import { StructuredValue } from "./StructuredValue";

describe("salientArg", () => {
  test("prefers a preferred key over other strings", () => {
    expect(salientArg({ path: "/src", pattern: "**/*.ts" })).toBe("**/*.ts");
    expect(salientArg({ url: "https://x.com" })).toBe("https://x.com");
  });

  test("falls back to the first string entry when no preferred key", () => {
    expect(salientArg({ flavor: "vanilla", count: 3 })).toBe("vanilla");
  });

  test("collapses to a truncated first line", () => {
    const long = `${"a".repeat(200)}\nsecond line`;
    const out = salientArg({ command: long }) ?? "";
    expect(out).not.toContain("\n");
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith("…")).toBe(true);
  });

  test("returns undefined when no string args exist", () => {
    expect(salientArg({ count: 3, ok: true })).toBeUndefined();
  });
});

describe("coerceStructured", () => {
  test("parses a JSON object/array into structure", () => {
    expect(coerceStructured('{"a": 1}')).toEqual({ a: 1 });
    expect(coerceStructured("[1, 2]")).toEqual([1, 2]);
  });

  test("leaves plain text and non-object JSON as a string", () => {
    expect(coerceStructured("just text")).toBe("just text");
    expect(coerceStructured("42")).toBe("42");
    expect(coerceStructured('{"broken": ')).toBe('{"broken": ');
  });
});

describe("StructuredValue", () => {
  test("renders nested objects and arrays as key/value, not JSON", () => {
    const { lastFrame } = render(
      <StructuredValue value={{ name: "grep", flags: ["-i", "-n"], opts: { recursive: true } }} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("name:");
    expect(frame).toContain("grep");
    expect(frame).toContain("flags:");
    expect(frame).toContain("-i");
    expect(frame).toContain("recursive:");
    expect(frame).toContain("true");
    expect(frame).not.toContain("{");
    expect(frame).not.toContain('"name"');
  });
});

describe("GenericTool", () => {
  const vis = (v: Visibility) => v;

  test("hide → header only", () => {
    const { lastFrame } = render(
      <GenericTool header="▸ Glob" body={{ pattern: "*.ts" }} visibility={vis("hide")} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Glob");
    expect(frame).not.toContain("pattern:");
  });

  test("summary → header + salient on one line", () => {
    const { lastFrame } = render(
      <GenericTool
        header="▸ Glob"
        body={{ pattern: "*.ts" }}
        salient="*.ts"
        visibility={vis("summary")}
      />,
    );
    const frame = (lastFrame() ?? "").trim();
    expect(frame.split("\n").length).toBe(1);
    expect(frame).toContain("Glob");
    expect(frame).toContain("*.ts");
  });

  test("instanceVisibility overrides the element visibility ahead of it", () => {
    // The #285 expand seam: a per-block override wins over the resolved
    // element visibility. Inert in production (no caller passes it) but the
    // resolution order is load-bearing when it lands.
    const { lastFrame } = render(
      <GenericTool
        header="▸ Glob"
        body={{ pattern: "*.ts" }}
        visibility={vis("hide")}
        blockId="tu-1"
        instanceVisibility={(id) => (id === "tu-1" ? "show" : undefined)}
      />,
    );
    expect(lastFrame() ?? "").toContain("pattern:");
  });
});
