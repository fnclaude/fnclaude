import { describe, expect, test } from "bun:test";
import { type Key, dispatchKey } from "./keybinds.ts";

const baseKey: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};

const meta = (input: string): { input: string; key: Key } => ({
  input,
  key: { ...baseKey, meta: true },
});

const ctrl = (input: string): { input: string; key: Key } => ({
  input,
  key: { ...baseKey, ctrl: true },
});

describe("dispatchKey — Alt+1-8 element toggles", () => {
  test("Alt+1 → toggle thinking", () => {
    const { input, key } = meta("1");
    expect(dispatchKey(input, key)).toEqual({
      kind: "toggleElement",
      element: "thinking",
    });
  });

  test("Alt+2 → toggle Bash.input", () => {
    const { input, key } = meta("2");
    expect(dispatchKey(input, key)).toEqual({
      kind: "toggleElement",
      element: "Bash.input",
    });
  });

  test("Alt+3 → toggle Bash.output", () => {
    const { input, key } = meta("3");
    expect(dispatchKey(input, key)).toEqual({
      kind: "toggleElement",
      element: "Bash.output",
    });
  });

  test("Alt+4 → toggle Edit.diff", () => {
    const { input, key } = meta("4");
    expect(dispatchKey(input, key)).toEqual({
      kind: "toggleElement",
      element: "Edit.diff",
    });
  });

  test("Alt+5 → toggle Read.content", () => {
    const { input, key } = meta("5");
    expect(dispatchKey(input, key)).toEqual({
      kind: "toggleElement",
      element: "Read.content",
    });
  });

  test("Alt+6 → toggle Write.content", () => {
    const { input, key } = meta("6");
    expect(dispatchKey(input, key)).toEqual({
      kind: "toggleElement",
      element: "Write.content",
    });
  });

  test("Alt+7 → toggle Task.nested", () => {
    const { input, key } = meta("7");
    expect(dispatchKey(input, key)).toEqual({
      kind: "toggleElement",
      element: "Task.nested",
    });
  });

  test("Alt+8 → toggle errors", () => {
    const { input, key } = meta("8");
    expect(dispatchKey(input, key)).toEqual({
      kind: "toggleElement",
      element: "errors",
    });
  });
});

describe("dispatchKey — preset cycle", () => {
  test("Alt+0 → cycle forward", () => {
    const { input, key } = meta("0");
    expect(dispatchKey(input, key)).toEqual({
      kind: "cyclePreset",
      direction: 1,
    });
  });

  test("Alt+9 → cycle backward", () => {
    const { input, key } = meta("9");
    expect(dispatchKey(input, key)).toEqual({
      kind: "cyclePreset",
      direction: -1,
    });
  });
});

describe("dispatchKey — control combos", () => {
  test("Ctrl+L → repaint", () => {
    const { input, key } = ctrl("l");
    expect(dispatchKey(input, key)).toEqual({ kind: "repaint" });
  });

  test("Ctrl+D → close stdin", () => {
    const { input, key } = ctrl("d");
    expect(dispatchKey(input, key)).toEqual({ kind: "closeStdin" });
  });

  test("Ctrl+C → interrupt", () => {
    const { input, key } = ctrl("c");
    expect(dispatchKey(input, key)).toEqual({ kind: "interrupt" });
  });
});

describe("dispatchKey — non-matches return null", () => {
  test("plain letter is null (let App handle text input)", () => {
    expect(dispatchKey("a", baseKey)).toBeNull();
  });

  test("Alt+a (non-digit meta) is null", () => {
    expect(dispatchKey("a", { ...baseKey, meta: true })).toBeNull();
  });

  test("Ctrl+x (unbound) is null", () => {
    expect(dispatchKey("x", { ...baseKey, ctrl: true })).toBeNull();
  });

  test("Enter alone is null (App handles submit)", () => {
    expect(dispatchKey("", { ...baseKey, return: true })).toBeNull();
  });
});
