import { describe, expect, test } from "bun:test";
import { type GithubRepo, tokenizeGithubAutolinks } from "./github-autolink.ts";

const REPO: GithubRepo = { owner: "fnclaude", name: "fnclaude" };

/** Pull the single linked segment out, asserting there is exactly one. */
function onlyLink(text: string, repo?: GithubRepo): { text: string; url: string } {
  const segs = tokenizeGithubAutolinks(text, repo);
  const links = segs.filter((s) => s.url !== undefined);
  expect(links.length).toBe(1);
  const link = links[0];
  if (link?.url === undefined) throw new Error("no link");
  return { text: link.text, url: link.url };
}

describe("tokenizeGithubAutolinks", () => {
  test("@username links to the user profile", () => {
    const l = onlyLink("hey @octocat thanks");
    expect(l.url).toBe("https://github.com/octocat");
    expect(l.text).toBe("@octocat");
  });

  test("@org/team links to the team page", () => {
    const l = onlyLink("ping @acme/backend now");
    expect(l.url).toBe("https://github.com/orgs/acme/teams/backend");
    expect(l.text).toBe("@acme/backend");
  });

  test("#123 links to issues when repo context is present", () => {
    const l = onlyLink("see #123 for details", REPO);
    expect(l.url).toBe("https://github.com/fnclaude/fnclaude/issues/123");
    expect(l.text).toBe("#123");
  });

  test("#123 stays plain when repo context is absent", () => {
    const segs = tokenizeGithubAutolinks("see #123 for details");
    expect(segs.every((s) => s.url === undefined)).toBe(true);
    expect(segs.map((s) => s.text).join("")).toBe("see #123 for details");
  });

  test("GH-123 (case-insensitive) links to issues with repo context", () => {
    const l = onlyLink("fixed gh-7 yesterday", REPO);
    expect(l.url).toBe("https://github.com/fnclaude/fnclaude/issues/7");
    expect(l.text).toBe("gh-7");
  });

  test("owner/repo#123 links explicitly, no context needed", () => {
    const l = onlyLink("dup of octocat/Hello-World#42");
    expect(l.url).toBe("https://github.com/octocat/Hello-World/issues/42");
    expect(l.text).toBe("octocat/Hello-World#42");
  });

  test("bare SHA links to a commit (with context), shortened to 7 chars", () => {
    const l = onlyLink("regressed in 1234567890abcdef as noted", REPO);
    expect(l.url).toBe("https://github.com/fnclaude/fnclaude/commit/1234567890abcdef");
    expect(l.text).toBe("1234567");
  });

  test("bare SHA stays plain without repo context", () => {
    const segs = tokenizeGithubAutolinks("regressed in 1234567890abcdef");
    expect(segs.every((s) => s.url === undefined)).toBe(true);
  });

  test("owner/repo@sha links cross-repo commit, no context needed", () => {
    const l = onlyLink("see octocat/Hello-World@abcdef1234 there");
    expect(l.url).toBe("https://github.com/octocat/Hello-World/commit/abcdef1234");
    expect(l.text).toBe("octocat/Hello-World@abcdef1");
  });

  test("email address does NOT match as an @mention", () => {
    const segs = tokenizeGithubAutolinks("write to foo@bar.com today");
    expect(segs.every((s) => s.url === undefined)).toBe(true);
    expect(segs.map((s) => s.text).join("")).toBe("write to foo@bar.com today");
  });

  test("multiple forms in one run all link", () => {
    const segs = tokenizeGithubAutolinks("@octocat see #1 and #2", REPO);
    const urls = segs.filter((s) => s.url !== undefined).map((s) => s.url);
    expect(urls).toEqual([
      "https://github.com/octocat",
      "https://github.com/fnclaude/fnclaude/issues/1",
      "https://github.com/fnclaude/fnclaude/issues/2",
    ]);
  });
});
