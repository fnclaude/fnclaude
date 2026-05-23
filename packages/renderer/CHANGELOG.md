# Changelog

## [2.0.1](https://github.com/fnclaude/fnclaude/compare/renderer-v2.0.0...renderer-v2.0.1) (2026-05-23)


### Bug Fixes

* **release-please:** drop node-workspace + ignore package.json in biome ([#27](https://github.com/fnclaude/fnclaude/issues/27)) ([c00f142](https://github.com/fnclaude/fnclaude/commit/c00f1429b7ad634552df14a1c87a4e1222ff105e))
* **renderer:** reformat package.json files array per biome ([#21](https://github.com/fnclaude/fnclaude/issues/21)) ([825ce07](https://github.com/fnclaude/fnclaude/commit/825ce071231d01aa8478a6af6d2d6e3b72b0d662))

## [2.0.0](https://github.com/fnclaude/fnclaude/compare/renderer-v1.0.2...renderer-v2.0.0) (2026-05-23)


### ⚠ BREAKING CHANGES

* **renderer:** npm package renamed `fnclaude-renderer` -> `@fnclaude/renderer`. The CLI binary name (`fnclaude-renderer`) is unchanged, so `npx @fnclaude/renderer` keeps working for end users. A follow-up will deprecate the old npm name.

### Features

* **renderer:** import as @fnclaude/renderer via git subtree ([#5](https://github.com/fnclaude/fnclaude/issues/5)) ([49c988d](https://github.com/fnclaude/fnclaude/commit/49c988dfa34a26c28bfc97f8cdb01f11fe33b772))
