/**
 * Centralized renderer palette.
 *
 * Every color the transcript emits routes through a {@link RendererTheme}
 * delivered via React context, instead of being hardcoded at each JSX call
 * site. This is the destination #294 (live light/dark detection via OSC 11 +
 * DEC 2031/997) drives: it produces a `"light" | "dark"` signal; this module
 * is the consumer that turns that signal into a re-render against a different
 * palette.
 *
 * Tokens are named by ROLE (link, error, diffAdded, …), never by raw color, so
 * the light/dark variants can disagree on the literal value while every call
 * site stays palette-agnostic. {@link DARK_THEME} reproduces the exact colors
 * the renderer used before this module existed — the migration is a visual
 * no-op on dark terminals until #294 flips the active theme.
 */

import { type ReactNode, createContext, useContext, useEffect, useState } from "react";

/**
 * The full set of color roles the renderer paints. Each value is an Ink color
 * (a named color like `"blue"` or a `"#rrggbb"` literal). `dimColor`-style
 * chrome (secondary headers, tool metadata, horizontal rules, heading H5/H6)
 * is intentionally NOT in here: it's a relative text-weight attribute that
 * reads correctly on both light and dark backgrounds, so it needs no palette
 * entry.
 */
export type RendererTheme = {
  // Markdown headings
  heading: string; // H1/H2
  headingAccent: string; // H3
  headingPlain: string; // H4
  // GFM inline
  link: string; // links, autolinks, `<a href>`
  inlineCode: string; // backtick spans + code-like inline HTML (code/tt/samp/var)
  // GFM block
  listMarkerOrdered: string; // ordered-list numbers
  listMarkerBullet: string; // unordered bullets
  listMarkerChecked: string; // task-list ✓ glyph
  codeBlockBorder: string; // fenced code block border
  blockquoteBorder: string; // plain blockquote left border
  // HTML inline
  kbd: string; // <kbd> glyphs
  rawMarkup: string; // passthrough / unhandled raw HTML
  // Blockquote alerts (GFM extension)
  alertNote: string;
  alertTip: string;
  alertImportant: string;
  alertWarning: string;
  alertCaution: string;
  // Diff
  diffAdded: string;
  diffRemoved: string;
  // Chrome / tool output
  promptMarker: string; // the "›" user-prompt marker
  error: string; // error output, ErrorRenderer
  result: string; // ResultRenderer soft warning
};

/**
 * Dark palette — the default, and a byte-for-byte reproduction of the colors
 * every renderer hardcoded before this module. Migrating to it must not change
 * a single emitted SGR code on a dark terminal.
 */
export const DARK_THEME: RendererTheme = {
  heading: "cyan",
  headingAccent: "blue",
  headingPlain: "white",
  link: "blue",
  inlineCode: "cyan",
  listMarkerOrdered: "yellow",
  listMarkerBullet: "cyan",
  listMarkerChecked: "green",
  codeBlockBorder: "gray",
  blockquoteBorder: "gray",
  kbd: "yellow",
  rawMarkup: "magenta",
  alertNote: "blue",
  alertTip: "green",
  alertImportant: "magenta",
  alertWarning: "yellow",
  alertCaution: "red",
  diffAdded: "green",
  diffRemoved: "red",
  promptMarker: "cyan",
  error: "red",
  result: "yellow",
};

/**
 * Light palette — the bright ANSI names that read fine on a dark background
 * wash out on a light one, so each is replaced with a darker, higher-contrast
 * shade. Greys keep their named value (legible against both). Values chosen for
 * contrast against a light background; #294 can refine them against a real
 * light-bg terminal.
 */
export const LIGHT_THEME: RendererTheme = {
  heading: "#005f87",
  headingAccent: "#0000af",
  headingPlain: "black",
  link: "#0000af",
  inlineCode: "#005f87",
  listMarkerOrdered: "#875f00",
  listMarkerBullet: "#005f87",
  listMarkerChecked: "#005f00",
  codeBlockBorder: "gray",
  blockquoteBorder: "gray",
  kbd: "#875f00",
  rawMarkup: "#870087",
  alertNote: "#0000af",
  alertTip: "#005f00",
  alertImportant: "#870087",
  alertWarning: "#875f00",
  alertCaution: "#870000",
  diffAdded: "#005f00",
  diffRemoved: "#870000",
  promptMarker: "#005f87",
  error: "#870000",
  result: "#875f00",
};

export type ThemeName = "light" | "dark";

/** Map a `"light" | "dark"` name (e.g. #294's signal) to its palette. */
export function themeForName(name: ThemeName): RendererTheme {
  return name === "light" ? LIGHT_THEME : DARK_THEME;
}

/**
 * Active palette. Defaults to {@link DARK_THEME} so a renderer used outside the
 * provider (a bare unit test, a fragment rendered in isolation) stays visually
 * identical to pre-theme behavior.
 */
export const RendererThemeContext = createContext<RendererTheme>(DARK_THEME);

/** Read the active palette. Call from any component inside the provider. */
export function useRendererTheme(): RendererTheme {
  return useContext(RendererThemeContext);
}

/**
 * Setter for the active palette, delivered alongside the theme so descendants
 * (or #294's detection code via {@link RendererThemeProviderProps.onReady}) can
 * flip it at runtime. Defaults to a no-op outside the provider.
 */
const SetRendererThemeContext = createContext<(theme: RendererTheme) => void>(() => undefined);

/** Access the runtime palette setter. */
export function useSetRendererTheme(): (theme: RendererTheme) => void {
  return useContext(SetRendererThemeContext);
}

/**
 * Resolve the startup palette from the `FNC_THEME` env override. Read once
 * before any detection runs: `FNC_THEME=light|dark` forces a palette and #294
 * should skip its OSC 11 query when it's set. Anything else (including unset)
 * defaults to dark.
 */
export function resolveInitialTheme(
  env: Record<string, string | undefined> = process.env,
): RendererTheme {
  return env.FNC_THEME?.toLowerCase() === "light" ? LIGHT_THEME : DARK_THEME;
}

export interface RendererThemeProviderProps {
  children: ReactNode;
  /**
   * Override the resolved startup palette. Production omits it (the palette is
   * resolved from {@link resolveInitialTheme}); tests pass an explicit value.
   */
  initialTheme?: RendererTheme;
  /**
   * Integration seam for #294: invoked once after mount with the live setter,
   * so the theme-detection code can flip the active palette at runtime — an
   * OSC 11 luminance result or a CSI 997 unsolicited report becomes
   * `setTheme(themeForName(signal))`, and React re-renders the tree.
   */
  onReady?: (setTheme: (theme: RendererTheme) => void) => void;
}

/**
 * Provides the active palette (and its setter) to the renderer tree. Holds the
 * theme in state so swapping it re-renders every consumer; mount this once
 * above the transcript (see mount.tsx). The default startup palette comes from
 * {@link resolveInitialTheme} unless `initialTheme` overrides it.
 */
export function RendererThemeProvider({
  children,
  initialTheme,
  onReady,
}: RendererThemeProviderProps): React.ReactElement {
  const [theme, setTheme] = useState<RendererTheme>(() => initialTheme ?? resolveInitialTheme());
  useEffect(() => {
    onReady?.(setTheme);
  }, [onReady]);
  return (
    <SetRendererThemeContext.Provider value={setTheme}>
      <RendererThemeContext.Provider value={theme}>{children}</RendererThemeContext.Provider>
    </SetRendererThemeContext.Provider>
  );
}
