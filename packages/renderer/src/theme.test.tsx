import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { AlertBlock } from "./renderers/AlertBlock.tsx";
import {
  DARK_THEME,
  LIGHT_THEME,
  type RendererTheme,
  RendererThemeContext,
  RendererThemeProvider,
  resolveInitialTheme,
  themeForName,
} from "./theme.tsx";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A representative renderer: AlertBlock paints its accent from the palette.
function noteUnder(theme: RendererTheme | undefined) {
  if (theme === undefined) {
    return render(<AlertBlock kind="note" bodyTokens={[]} renderChildren={() => null} />);
  }
  return render(
    <RendererThemeContext.Provider value={theme}>
      <AlertBlock kind="note" bodyTokens={[]} renderChildren={() => null} />
    </RendererThemeContext.Provider>,
  );
}

describe("theme palette", () => {
  test("themeForName / resolveInitialTheme map to the right palette", () => {
    expect(themeForName("dark")).toBe(DARK_THEME);
    expect(themeForName("light")).toBe(LIGHT_THEME);
    expect(resolveInitialTheme({})).toBe(DARK_THEME);
    expect(resolveInitialTheme({ FNC_THEME: "light" })).toBe(LIGHT_THEME);
    expect(resolveInitialTheme({ FNC_THEME: "LIGHT" })).toBe(LIGHT_THEME);
    expect(resolveInitialTheme({ FNC_THEME: "dark" })).toBe(DARK_THEME);
    expect(resolveInitialTheme({ FNC_THEME: "nonsense" })).toBe(DARK_THEME);
  });

  test("dark/light palettes disagree on the note accent value", () => {
    // Guards against the two themes accidentally collapsing to the same value.
    expect(DARK_THEME.alertNote).not.toBe(LIGHT_THEME.alertNote);
  });
});

describe("renderer reads palette from context", () => {
  test("AlertBlock paints the dark accent (blue SGR 34) under the dark theme", () => {
    const { lastFrame } = noteUnder(DARK_THEME);
    // "blue" → SGR 34. This is the byte-identical pre-theme behavior.
    expect(lastFrame() ?? "").toContain("\x1B[34m");
  });

  test("flipping the active theme via context changes the emitted color", () => {
    const dark = noteUnder(DARK_THEME).lastFrame() ?? "";
    const light = noteUnder(LIGHT_THEME).lastFrame() ?? "";
    // Same component, same content — only the palette differs, so the frames
    // (specifically the accent SGR) must differ. Fails if AlertBlock ignores
    // the context and hardcodes its color.
    expect(light).not.toBe(dark);
    expect(light).not.toContain("\x1B[34m");
  });
});

describe("RendererThemeProvider runtime switching", () => {
  test("default (no override) renders the dark palette", () => {
    const { lastFrame } = render(
      <RendererThemeProvider initialTheme={DARK_THEME}>
        <AlertBlock kind="note" bodyTokens={[]} renderChildren={() => null} />
      </RendererThemeProvider>,
    );
    expect(lastFrame() ?? "").toContain("\x1B[34m");
  });

  test("onReady setter swaps the active palette at runtime → re-render", async () => {
    // Holder object so TS doesn't narrow the captured setter back to `null`
    // (a render() call between assignment and use widens the property again).
    const captured: { setTheme: ((t: RendererTheme) => void) | null } = { setTheme: null };
    const { lastFrame } = render(
      <RendererThemeProvider
        initialTheme={DARK_THEME}
        onReady={(s) => {
          captured.setTheme = s;
        }}
      >
        <AlertBlock kind="note" bodyTokens={[]} renderChildren={() => null} />
      </RendererThemeProvider>,
    );
    await delay(0);
    expect(lastFrame() ?? "").toContain("\x1B[34m");
    expect(captured.setTheme).not.toBeNull();
    captured.setTheme?.(LIGHT_THEME);
    await delay(0);
    expect(lastFrame() ?? "").not.toContain("\x1B[34m");
  });
});
