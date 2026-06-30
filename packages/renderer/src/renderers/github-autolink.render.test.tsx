import { afterEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { MarkdownRenderer } from "./MarkdownRenderer";
import type { GithubRepo } from "./github-autolink.ts";
import { GithubRepoContext } from "./github-repo-context.ts";
import { setHyperlinkSupportOverride } from "./osc8";

const REPO: GithubRepo = { owner: "fnclaude", name: "fnclaude" };

function renderWithRepo(node: ReactElement, repo?: GithubRepo) {
  return render(<GithubRepoContext.Provider value={repo}>{node}</GithubRepoContext.Provider>);
}

describe("GitHub autolinks in MarkdownRenderer", () => {
  afterEach(() => setHyperlinkSupportOverride(undefined));

  test("hyperlinks ON: @mention emits OSC 8 to the profile, blue+underline", () => {
    setHyperlinkSupportOverride(true);
    const { lastFrame } = renderWithRepo(<MarkdownRenderer text="thanks @octocat" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("\x1b]8;;https://github.com/octocat\x07");
    expect(frame).toContain("@octocat");
    expect(frame).toMatch(/\x1B\[34m/); // blue
    expect(frame).toMatch(/\x1B\[4m/); // underline
  });

  test("hyperlinks ON: #ref links against repo context", () => {
    setHyperlinkSupportOverride(true);
    const { lastFrame } = renderWithRepo(<MarkdownRenderer text="see #123 now" />, REPO);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("\x1b]8;;https://github.com/fnclaude/fnclaude/issues/123\x07");
    expect(frame).toContain("#123");
  });

  test("hyperlinks OFF: @mention is blue+underline, no OSC 8 bytes", () => {
    // Autolinks share the markdown-link underline policy: a link reads as a
    // link (blue+underline) even when the terminal can't make it clickable.
    setHyperlinkSupportOverride(false);
    const { lastFrame } = renderWithRepo(<MarkdownRenderer text="thanks @octocat" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("@octocat");
    expect(frame).toMatch(/\x1B\[34m/); // blue
    expect(frame).toMatch(/\x1B\[4m/); // underlined — consistent with markdown links
    expect(frame).not.toContain("\x1b]8"); // no OSC 8 at all
  });

  test("no repo context: #ref stays plain (no link, no OSC 8)", () => {
    setHyperlinkSupportOverride(true);
    const { lastFrame } = renderWithRepo(<MarkdownRenderer text="see #123 now" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("#123");
    expect(frame).not.toContain("\x1b]8"); // not linked
  });

  test("codespan content is never autolinked", () => {
    setHyperlinkSupportOverride(true);
    const { lastFrame } = renderWithRepo(
      <MarkdownRenderer text="use `@octocat` literally" />,
      REPO,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("@octocat");
    expect(frame).not.toContain("\x1b]8;;https://github.com/octocat"); // no link from code
  });
});
