import { describe, expect, test } from "bun:test";
import {
  type Env,
  type TerminalCapabilities,
  detectCapabilities,
} from "./capabilities";

// Representative env fixtures. Each terminal sets a different subset of
// signals; the module must reduce them to one capability object.
const ghostty: Env = {
  TERM: "xterm-ghostty",
  TERM_PROGRAM: "ghostty",
  GHOSTTY_RESOURCES_DIR: "/usr/share/ghostty",
  COLORTERM: "truecolor",
};

const iterm3: Env = {
  TERM: "xterm-256color",
  TERM_PROGRAM: "iTerm.app",
  TERM_PROGRAM_VERSION: "3.4.23",
  ITERM_SESSION_ID: "w0t0p0",
  COLORTERM: "truecolor",
};

const iterm2Old: Env = {
  TERM: "xterm-256color",
  TERM_PROGRAM: "iTerm.app",
  TERM_PROGRAM_VERSION: "2.9.20160520",
  ITERM_SESSION_ID: "w0t0p0",
  COLORTERM: "truecolor",
};

const vscode: Env = {
  TERM: "xterm-256color",
  TERM_PROGRAM: "vscode",
  TERM_PROGRAM_VERSION: "1.90.0",
  COLORTERM: "truecolor",
};

const wezterm: Env = {
  TERM: "xterm-256color",
  TERM_PROGRAM: "WezTerm",
  TERM_PROGRAM_VERSION: "20240203-110809",
  COLORTERM: "truecolor",
};

const kittyEnv: Env = {
  TERM: "xterm-kitty",
  KITTY_WINDOW_ID: "1",
  COLORTERM: "truecolor",
};

const plainXterm: Env = {
  TERM: "xterm",
};

describe("detectCapabilities", () => {
  test("ghostty: full graphics + interactivity stack", () => {
    expect(detectCapabilities(ghostty)).toEqual({
      hyperlinks: true,
      images: "kitty",
      clipboard: true,
      themeNotify: true,
      color: "truecolor",
    });
  });

  test("iTerm2 >= 3 supports inline images", () => {
    const caps = detectCapabilities(iterm3);
    expect(caps.images).toBe("iterm2");
    expect(caps.hyperlinks).toBe(true);
    expect(caps.clipboard).toBe(true);
    expect(caps.color).toBe("truecolor");
  });

  test("iTerm2 < 3 does not support inline images (version gating)", () => {
    const caps = detectCapabilities(iterm2Old);
    // No iterm2 graphics; falls back to half-block since color is present.
    expect(caps.images).toBe("half-block");
    expect(caps.hyperlinks).toBe(true);
  });

  test("vscode: color + hyperlinks, half-block images", () => {
    const caps = detectCapabilities(vscode);
    expect(caps.images).toBe("half-block");
    expect(caps.hyperlinks).toBe(true);
    expect(caps.color).toBe("truecolor");
  });

  test("WezTerm: kitty graphics protocol", () => {
    const caps = detectCapabilities(wezterm);
    expect(caps.images).toBe("kitty");
    expect(caps.hyperlinks).toBe(true);
    expect(caps.color).toBe("truecolor");
  });

  test("kitty via KITTY_WINDOW_ID presence", () => {
    const caps = detectCapabilities(kittyEnv);
    expect(caps.images).toBe("kitty");
    expect(caps.hyperlinks).toBe(true);
    expect(caps.themeNotify).toBe(true);
  });

  test("plain xterm: conservative defaults", () => {
    expect(detectCapabilities(plainXterm)).toEqual({
      hyperlinks: false,
      images: "none",
      clipboard: false,
      themeNotify: false,
      color: "16",
    });
  });

  test("fully unknown env: all-false / none / 16", () => {
    expect(detectCapabilities({})).toEqual({
      hyperlinks: false,
      images: "none",
      clipboard: false,
      themeNotify: false,
      color: "16",
    });
  });

  describe("color overrides", () => {
    test("NO_COLOR suppresses color and image rendering", () => {
      const caps = detectCapabilities({ ...ghostty, NO_COLOR: "1" });
      expect(caps.color).toBe("none");
      expect(caps.images).toBe("none");
      // Non-color capabilities are unaffected by NO_COLOR.
      expect(caps.hyperlinks).toBe(true);
      expect(caps.clipboard).toBe(true);
      expect(caps.themeNotify).toBe(true);
    });

    test("empty NO_COLOR is ignored (per no-color.org spec)", () => {
      const caps = detectCapabilities({ ...ghostty, NO_COLOR: "" });
      expect(caps.color).toBe("truecolor");
      expect(caps.images).toBe("kitty");
    });

    test("FORCE_COLOR overrides detection upward on a plain terminal", () => {
      const caps = detectCapabilities({ ...plainXterm, FORCE_COLOR: "3" });
      expect(caps.color).toBe("truecolor");
    });

    test("FORCE_COLOR=0 disables color", () => {
      const caps = detectCapabilities({ ...ghostty, FORCE_COLOR: "0" });
      expect(caps.color).toBe("none");
      expect(caps.images).toBe("none");
    });

    test("FORCE_COLOR=2 selects 256", () => {
      expect(detectCapabilities({ FORCE_COLOR: "2" }).color).toBe("256");
    });

    test("COLORTERM=24bit reads as truecolor", () => {
      expect(detectCapabilities({ TERM: "xterm", COLORTERM: "24bit" }).color).toBe(
        "truecolor",
      );
    });

    test("TERM=dumb yields no color", () => {
      expect(detectCapabilities({ TERM: "dumb" }).color).toBe("none");
    });

    test("TERM with 256 yields 256-color", () => {
      expect(detectCapabilities({ TERM: "screen-256color" }).color).toBe("256");
    });
  });

  describe("env-presence probes", () => {
    test("VTE_VERSION >= 5000 enables hyperlinks", () => {
      expect(detectCapabilities({ TERM: "xterm", VTE_VERSION: "6800" }).hyperlinks).toBe(
        true,
      );
    });

    test("VTE_VERSION < 5000 does not enable hyperlinks", () => {
      expect(detectCapabilities({ TERM: "xterm", VTE_VERSION: "4600" }).hyperlinks).toBe(
        false,
      );
    });

    test("WT_SESSION (Windows Terminal) enables hyperlinks + clipboard", () => {
      const caps = detectCapabilities({ TERM: "xterm", WT_SESSION: "abc" });
      expect(caps.hyperlinks).toBe(true);
      expect(caps.clipboard).toBe(true);
    });

    test("KONSOLE_VERSION enables hyperlinks", () => {
      expect(
        detectCapabilities({ TERM: "xterm", KONSOLE_VERSION: "220400" }).hyperlinks,
      ).toBe(true);
    });

    test("any GHOSTTY* var enables kitty graphics", () => {
      const caps = detectCapabilities({ TERM: "xterm", GHOSTTY_BIN_DIR: "/x" });
      expect(caps.images).toBe("kitty");
      expect(caps.hyperlinks).toBe(true);
    });

    test("FORCE_HYPERLINK forces OSC 8 on an unknown terminal", () => {
      expect(detectCapabilities({ TERM: "xterm", FORCE_HYPERLINK: "1" }).hyperlinks).toBe(
        true,
      );
    });
  });

  test("Apple_Terminal: no OSC 8, no graphics protocols", () => {
    const caps = detectCapabilities({
      TERM: "xterm-256color",
      TERM_PROGRAM: "Apple_Terminal",
      TERM_PROGRAM_VERSION: "453",
    });
    expect(caps.hyperlinks).toBe(false);
    expect(caps.images).toBe("half-block");
    expect(caps.themeNotify).toBe(false);
    expect(caps.color).toBe("256");
  });

  test("result object is frozen", () => {
    const caps = detectCapabilities(ghostty) as TerminalCapabilities;
    expect(Object.isFrozen(caps)).toBe(true);
  });
});
