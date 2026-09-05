# Changelog

## [3.5.0](https://github.com/fnclaude/fnclaude/compare/renderer-v3.4.0...renderer-v3.5.0) (2026-09-05)


### Features

* **docs:** documentation site (Astro Starlight) + rename docs/ to specs/ ([#356](https://github.com/fnclaude/fnclaude/issues/356)) ([cc0f50d](https://github.com/fnclaude/fnclaude/commit/cc0f50d464418eba6e4f670bbd8c67007f7c0ef5))

## [3.4.0](https://github.com/fnclaude/fnclaude/compare/renderer-v3.3.1...renderer-v3.4.0) (2026-07-03)


### Features

* fnc-native //slash-command framework with //restart ([#315](https://github.com/fnclaude/fnclaude/issues/315)) ([4fb14c5](https://github.com/fnclaude/fnclaude/commit/4fb14c523d4d1e1bf6fa8e23cb2a0046b2877510))
* GitHub [@mention](https://github.com/mention) / #ref / commit-SHA autolinks in the renderer ([#278](https://github.com/fnclaude/fnclaude/issues/278)) ([19423b4](https://github.com/fnclaude/fnclaude/commit/19423b4c66ee38a3aa561201a3c415d82c8d9914))
* **renderer:** app-owned scroll viewport with Alt+u token-burn toggle ([#284](https://github.com/fnclaude/fnclaude/issues/284)) ([c3a6f1a](https://github.com/fnclaude/fnclaude/commit/c3a6f1accffce5a8b57912f220217b77f4338094))
* **renderer:** bordered prompt area with session badge ([#314](https://github.com/fnclaude/fnclaude/issues/314)) ([7b9ef9d](https://github.com/fnclaude/fnclaude/commit/7b9ef9d8ad8af12a08419a14f52ec58d8f64204e))
* **renderer:** centralized theme palette with runtime light/dark switching ([#309](https://github.com/fnclaude/fnclaude/issues/309)) ([3849145](https://github.com/fnclaude/fnclaude/commit/38491456117520b134283acc44d3d09623e538fe))
* **renderer:** clickable links via OSC 8 hyperlinks ([#276](https://github.com/fnclaude/fnclaude/issues/276)) ([dcaa729](https://github.com/fnclaude/fnclaude/commit/dcaa729b1b8b4c27b0eecca5b2c65cc149bcdce3))
* **renderer:** env-only terminal capability detection module ([#303](https://github.com/fnclaude/fnclaude/issues/303)) ([7eb375d](https://github.com/fnclaude/fnclaude/commit/7eb375d0039c780dd3c6bc17bcd910921708bbcd))
* **renderer:** GFM tables, syntax highlighting, alerts, heading levels, task lists, entities, OSC 8 links ([#261](https://github.com/fnclaude/fnclaude/issues/261)) ([bd6fb55](https://github.com/fnclaude/fnclaude/commit/bd6fb5557c5cd3a4a491432c4fbc58d7560923c3))
* **renderer:** interpret HTML subset (kbd/mark/br/hr/sub/sup/raw-a), color raw markup ([#279](https://github.com/fnclaude/fnclaude/issues/279)) ([1948f6b](https://github.com/fnclaude/fnclaude/commit/1948f6bd5978b06096c33f8ca0a447e3139d5aae))
* **renderer:** multi-line prompt input via Shift+Enter and backslash ([#259](https://github.com/fnclaude/fnclaude/issues/259)) ([75e08b7](https://github.com/fnclaude/fnclaude/commit/75e08b7b9dc6f9163026a4c94e0dd42a9b84af19))
* **renderer:** native Claude-Code look — markdown, noise filter, user prompts ([#256](https://github.com/fnclaude/fnclaude/issues/256)) ([7e5161c](https://github.com/fnclaude/fnclaude/commit/7e5161c6e2ff204b84fe3cb8b87ec7a8959856aa))
* **renderer:** render GitHub emoji shortcodes (:rocket: etc.) ([#280](https://github.com/fnclaude/fnclaude/issues/280)) ([67bf7f5](https://github.com/fnclaude/fnclaude/commit/67bf7f5e135783818020763f7a0be43a6b3c682d))
* **renderer:** render GitHub emoji shortcodes (:rocket: etc.) ([#281](https://github.com/fnclaude/fnclaude/issues/281)) ([09a44c2](https://github.com/fnclaude/fnclaude/commit/09a44c2c8fb743937c4d3e47d27ba8335d76db20))
* **renderer:** render submitted user prompts as markdown ([#258](https://github.com/fnclaude/fnclaude/issues/258)) ([eda0abb](https://github.com/fnclaude/fnclaude/commit/eda0abbed2df2fd5c36bbe2bf61802aab68cf2ec))
* **renderer:** scroll-position indicator in transcript viewport ([#306](https://github.com/fnclaude/fnclaude/issues/306)) ([4b28f33](https://github.com/fnclaude/fnclaude/commit/4b28f33b6cb428206e294859a9c1adffd993566d))
* **renderer:** structured generic tool renderer for unknown tools ([#313](https://github.com/fnclaude/fnclaude/issues/313)) ([9b07b4b](https://github.com/fnclaude/fnclaude/commit/9b07b4b66b7fd5f28d85b68894639c09f3af46a3))


### Bug Fixes

* **renderer:** Ctrl+C interrupts claude's turn instead of killing fnc ([#277](https://github.com/fnclaude/fnclaude/issues/277)) ([a279f07](https://github.com/fnclaude/fnclaude/commit/a279f075929f48fa52f48a734cb79fe2a81c79d8))
* **renderer:** drop OSC 8 link escapes; keep http styled+Ghostty-clickable, plain non-clickable ([#263](https://github.com/fnclaude/fnclaude/issues/263)) ([de0a0d7](https://github.com/fnclaude/fnclaude/commit/de0a0d725cd98b769fc38cd71ea2f445b4f87f82))
* **renderer:** measure table cell width from rendered tokens, not raw cell.text ([#272](https://github.com/fnclaude/fnclaude/issues/272)) ([2959ee0](https://github.com/fnclaude/fnclaude/commit/2959ee056168152ce2058fd618169661132661dd))

## [3.3.1](https://github.com/fnclaude/fnclaude/compare/renderer-v3.3.0...renderer-v3.3.1) (2026-06-26)


### Bug Fixes

* **renderer:** always render input prompt so bare session shows it's interactive ([#249](https://github.com/fnclaude/fnclaude/issues/249)) ([26f7900](https://github.com/fnclaude/fnclaude/commit/26f790071a25ccfd8a44980fc484828f92f79706))

## [3.3.0](https://github.com/fnclaude/fnclaude/compare/renderer-v3.2.0...renderer-v3.3.0) (2026-06-18)


### Features

* **renderer:** mountRenderer owns subscription + returns handle; error boundary ([#234](https://github.com/fnclaude/fnclaude/issues/234)) ([8658591](https://github.com/fnclaude/fnclaude/commit/865859178dcad1a5d19e1e086dcf90d347723117))

## [3.2.0](https://github.com/fnclaude/fnclaude/compare/renderer-v3.1.0...renderer-v3.2.0) (2026-06-18)


### Features

* **renderer:** render stream-json faithfully incl token streaming ([#231](https://github.com/fnclaude/fnclaude/issues/231)) ([709b310](https://github.com/fnclaude/fnclaude/commit/709b31069b784d6dbf2670dbd6dbfab4445b8eaa))

## [3.1.0](https://github.com/fnclaude/fnclaude/compare/renderer-v3.0.0...renderer-v3.1.0) (2026-06-18)


### Features

* **renderer:** add importable mountRenderer entry point ([#226](https://github.com/fnclaude/fnclaude/issues/226)) ([e60f7ad](https://github.com/fnclaude/fnclaude/commit/e60f7ad8bf9db578ae8c7d8cf10ff7bd5644006e))

## [3.0.0](https://github.com/fnclaude/fnclaude/compare/renderer-v2.0.2...renderer-v3.0.0) (2026-05-27)


### ⚠ BREAKING CHANGES

* **cli:** Version bump to v1.0.0. The API surface is identical to 0.7.8 but pinned dependencies on ^0.7.x should update to ^1.0.0.

### Features

* **cli:** graduate @fnclaude/cli to v1.0.0 ([#101](https://github.com/fnclaude/fnclaude/issues/101)) ([d34bb1f](https://github.com/fnclaude/fnclaude/commit/d34bb1f1a1217d37de82d1c3aa3431eff6a62a3e))

## [2.0.2](https://github.com/fnclaude/fnclaude/compare/renderer-v2.0.1...renderer-v2.0.2) (2026-05-25)


### Bug Fixes

* minor adjustments to trigger [@latest](https://github.com/latest) publishes for all three packages ([#71](https://github.com/fnclaude/fnclaude/issues/71)) ([9957c66](https://github.com/fnclaude/fnclaude/commit/9957c66652ae2fdeaa4fc968e3cf3a3eff5d5a67))

## [2.0.1](https://github.com/fnclaude/fnclaude/compare/renderer-v2.0.0...renderer-v2.0.1) (2026-05-23)


### Bug Fixes

* **release-please:** drop node-workspace + ignore package.json in biome ([#27](https://github.com/fnclaude/fnclaude/issues/27)) ([c00f142](https://github.com/fnclaude/fnclaude/commit/c00f1429b7ad634552df14a1c87a4e1222ff105e))
* **renderer:** reformat package.json files array per biome ([#21](https://github.com/fnclaude/fnclaude/issues/21)) ([825ce07](https://github.com/fnclaude/fnclaude/commit/825ce071231d01aa8478a6af6d2d6e3b72b0d662))

## [2.0.0](https://github.com/fnclaude/fnclaude/compare/renderer-v1.0.2...renderer-v2.0.0) (2026-05-23)


### ⚠ BREAKING CHANGES

* **renderer:** npm package renamed `fnclaude-renderer` -> `@fnclaude/renderer`. The CLI binary name (`fnclaude-renderer`) is unchanged, so `npx @fnclaude/renderer` keeps working for end users. A follow-up will deprecate the old npm name.

### Features

* **renderer:** import as @fnclaude/renderer via git subtree ([#5](https://github.com/fnclaude/fnclaude/issues/5)) ([49c988d](https://github.com/fnclaude/fnclaude/commit/49c988dfa34a26c28bfc97f8cdb01f11fe33b772))
