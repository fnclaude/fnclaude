# fnclaude — product requirements

User-facing feature requirements for fnclaude, the quality-of-life launcher for `claude`.

## Documents

- [**prd.launcher.md**](prd.launcher.md) — Everything users experience when invoking fnclaude: model/effort shortcuts, session-type words, directory targeting (paths, repo references, multi-dir), inline prompts, auto-naming, worktree intercept, short flags, auto-tmux, config, cross-cwd resume, noop fallback, shell completion, install.

- [**prd.in-session.md**](prd.in-session.md) — Everything users experience while inside a running fnclaude-launched session: project switching, noop routing, session restart, sibling session spawn, clipboard handoff.

- [**design.md**](design.md) — Locked-in technical requirements derived from the Go reference implementation. Wire formats, exact regexes, env var contracts, session JSONL read mechanics, file-path patterns, denylist tables. Intended for rewrite engineers.

- [**specs.md**](specs.md) — Go-canonical behavior reference extracted from source code. Every behavior verified against Go source; README divergences noted. Cross-reference only — do not modify.
