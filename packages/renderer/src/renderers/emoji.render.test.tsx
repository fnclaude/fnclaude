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

describe("emoji shortcodes in MarkdownRenderer", () => {
  afterEach(() => setHyperlinkSupportOverride(undefined));

  test("plain-text shortcode renders its glyph", () => {
    const { lastFrame } = renderWithRepo(<MarkdownRenderer text="to the moon :rocket:" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("🚀");
    expect(frame).not.toContain(":rocket:");
  });

  test("unknown shortcode stays literal", () => {
    const { lastFrame } = renderWithRepo(<MarkdownRenderer text="a :notareal: code" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain(":notareal:");
  });

  test("shortcode inside a codespan is NOT emojified", () => {
    const { lastFrame } = renderWithRepo(<MarkdownRenderer text="use `:rocket:` literally" />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain(":rocket:");
    expect(frame).not.toContain("🚀");
  });

  test("shortcode inside a fenced code block is NOT emojified", () => {
    const { lastFrame } = renderWithRepo(<MarkdownRenderer text={"```\n:rocket:\n```"} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain(":rocket:");
    expect(frame).not.toContain("🚀");
  });

  test("shortcode adjacent to an @mention emojifies text, keeps the autolink", () => {
    setHyperlinkSupportOverride(true);
    const { lastFrame } = renderWithRepo(
      <MarkdownRenderer text="nice work @octocat :tada:" />,
      REPO,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("🎉");
    expect(frame).toContain("@octocat");
    expect(frame).toContain("\x1b]8;;https://github.com/octocat\x07");
  });
});
