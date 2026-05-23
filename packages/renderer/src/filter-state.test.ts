import { describe, expect, test } from "bun:test";
import { cyclePreset, defaultState, resolve, toggleElement } from "./filter-state.ts";
import type { FilterState } from "./types/events.ts";

describe("defaultState", () => {
  test("starts on normal preset with no overrides", () => {
    const state = defaultState();
    expect(state.preset).toBe("normal");
    expect(state.overrides).toEqual({});
  });
});

describe("resolve — preset defaults", () => {
  const presets = (overrides: FilterState["overrides"] = {}) => ({
    quiet: { preset: "quiet", overrides } as FilterState,
    normal: { preset: "normal", overrides } as FilterState,
    verbose: { preset: "verbose", overrides } as FilterState,
    debug: { preset: "debug", overrides } as FilterState,
  });

  test("thinking: hide / dim / dim / show", () => {
    const p = presets();
    expect(resolve("thinking", p.quiet)).toBe("hide");
    expect(resolve("thinking", p.normal)).toBe("dim");
    expect(resolve("thinking", p.verbose)).toBe("dim");
    expect(resolve("thinking", p.debug)).toBe("show");
  });

  test("Bash.input: summary / show / show / show", () => {
    const p = presets();
    expect(resolve("Bash.input", p.quiet)).toBe("summary");
    expect(resolve("Bash.input", p.normal)).toBe("show");
    expect(resolve("Bash.input", p.verbose)).toBe("show");
    expect(resolve("Bash.input", p.debug)).toBe("show");
  });

  test("Bash.output: hide / hide / show / show", () => {
    const p = presets();
    expect(resolve("Bash.output", p.quiet)).toBe("hide");
    expect(resolve("Bash.output", p.normal)).toBe("hide");
    expect(resolve("Bash.output", p.verbose)).toBe("show");
    expect(resolve("Bash.output", p.debug)).toBe("show");
  });

  test("Edit.diff: summary / show / show / show", () => {
    const p = presets();
    expect(resolve("Edit.diff", p.quiet)).toBe("summary");
    expect(resolve("Edit.diff", p.normal)).toBe("show");
    expect(resolve("Edit.diff", p.verbose)).toBe("show");
    expect(resolve("Edit.diff", p.debug)).toBe("show");
  });

  test("Read.content: hide / hide / summary / show", () => {
    const p = presets();
    expect(resolve("Read.content", p.quiet)).toBe("hide");
    expect(resolve("Read.content", p.normal)).toBe("hide");
    expect(resolve("Read.content", p.verbose)).toBe("summary");
    expect(resolve("Read.content", p.debug)).toBe("show");
  });

  test("Write.content: summary / summary / show / show", () => {
    const p = presets();
    expect(resolve("Write.content", p.quiet)).toBe("summary");
    expect(resolve("Write.content", p.normal)).toBe("summary");
    expect(resolve("Write.content", p.verbose)).toBe("show");
    expect(resolve("Write.content", p.debug)).toBe("show");
  });

  test("Task.nested: summary / summary / show / show", () => {
    const p = presets();
    expect(resolve("Task.nested", p.quiet)).toBe("summary");
    expect(resolve("Task.nested", p.normal)).toBe("summary");
    expect(resolve("Task.nested", p.verbose)).toBe("show");
    expect(resolve("Task.nested", p.debug)).toBe("show");
  });

  test("errors: show across all presets", () => {
    const p = presets();
    expect(resolve("errors", p.quiet)).toBe("show");
    expect(resolve("errors", p.normal)).toBe("show");
    expect(resolve("errors", p.verbose)).toBe("show");
    expect(resolve("errors", p.debug)).toBe("show");
  });
});

describe("resolve — overrides take precedence", () => {
  test("override beats preset default", () => {
    const state: FilterState = {
      preset: "normal",
      overrides: { "Bash.output": "show" },
    };
    expect(resolve("Bash.output", state)).toBe("show");
  });

  test("non-overridden element still uses preset default", () => {
    const state: FilterState = {
      preset: "verbose",
      overrides: { "Bash.output": "hide" },
    };
    expect(resolve("Read.content", state)).toBe("summary");
  });
});

describe("toggleElement", () => {
  test("no override on a normally-shown element → flips to opposite (hide)", () => {
    const state = defaultState(); // normal
    // Bash.input default in normal is "show"
    const next = toggleElement(state, "Bash.input");
    expect(next.overrides["Bash.input"]).toBe("hide");
    expect(resolve("Bash.input", next)).toBe("hide");
  });

  test("no override on a hidden element → flips to opposite (show)", () => {
    const state = defaultState(); // normal
    // Bash.output default in normal is "hide"
    const next = toggleElement(state, "Bash.output");
    expect(next.overrides["Bash.output"]).toBe("show");
    expect(resolve("Bash.output", next)).toBe("show");
  });

  test("dim default → flips to hide (opposite-of-shown)", () => {
    // thinking default in normal is "dim" — dim is a shown variant,
    // so toggling should flip to "hide".
    const state = defaultState();
    const next = toggleElement(state, "thinking");
    expect(next.overrides.thinking).toBe("hide");
  });

  test("summary default → flips to hide", () => {
    // Edit.diff default in normal is "show" actually — pick one that's summary.
    // Task.nested in normal is "summary".
    const state = defaultState();
    const next = toggleElement(state, "Task.nested");
    expect(next.overrides["Task.nested"]).toBe("hide");
  });

  test("existing override → clears (reverts to preset default)", () => {
    const state: FilterState = {
      preset: "normal",
      overrides: { "Bash.output": "show" },
    };
    const next = toggleElement(state, "Bash.output");
    expect(next.overrides["Bash.output"]).toBeUndefined();
    expect(resolve("Bash.output", next)).toBe("hide");
  });

  test("does not mutate input state", () => {
    const state = defaultState();
    const before = JSON.stringify(state);
    toggleElement(state, "Bash.output");
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe("cyclePreset", () => {
  test("forward: quiet → normal → verbose → debug → quiet", () => {
    let s: FilterState = { preset: "quiet", overrides: {} };
    s = cyclePreset(s, 1);
    expect(s.preset).toBe("normal");
    s = cyclePreset(s, 1);
    expect(s.preset).toBe("verbose");
    s = cyclePreset(s, 1);
    expect(s.preset).toBe("debug");
    s = cyclePreset(s, 1);
    expect(s.preset).toBe("quiet");
  });

  test("backward: quiet → debug → verbose → normal → quiet", () => {
    let s: FilterState = { preset: "quiet", overrides: {} };
    s = cyclePreset(s, -1);
    expect(s.preset).toBe("debug");
    s = cyclePreset(s, -1);
    expect(s.preset).toBe("verbose");
    s = cyclePreset(s, -1);
    expect(s.preset).toBe("normal");
    s = cyclePreset(s, -1);
    expect(s.preset).toBe("quiet");
  });

  test("clears all overrides", () => {
    const state: FilterState = {
      preset: "normal",
      overrides: { "Bash.output": "show", thinking: "hide" },
    };
    const next = cyclePreset(state, 1);
    expect(next.preset).toBe("verbose");
    expect(next.overrides).toEqual({});
  });
});
