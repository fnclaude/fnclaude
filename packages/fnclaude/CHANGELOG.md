# Changelog

## [2.2.0](https://github.com/fnclaude/fnclaude/compare/fnclaude-v2.1.0...fnclaude-v2.2.0) (2026-09-05)


### Features

* restructure — renderer excise, rhombus.rocks config, fngit, OOBE ([#360](https://github.com/fnclaude/fnclaude/issues/360)) ([c84fcef](https://github.com/fnclaude/fnclaude/commit/c84fcef98bb017e127d5fcf20c934595aed45837))

## [2.1.0](https://github.com/fnclaude/fnclaude/compare/fnclaude-v2.0.2...fnclaude-v2.1.0) (2026-05-27)


### Features

* **cli:** own the Bun argv-stripping shim; collapse umbrella to thin delegator ([#112](https://github.com/fnclaude/fnclaude/issues/112)) ([84a6655](https://github.com/fnclaude/fnclaude/commit/84a66553bce93924bba6a87cba6c5a43114f19d3))

## [2.0.2](https://github.com/fnclaude/fnclaude/compare/fnclaude-v2.0.1...fnclaude-v2.0.2) (2026-05-27)


### Bug Fixes

* **fnclaude,cli:** pass argv via env var to bypass Bun's -- stripping ([#108](https://github.com/fnclaude/fnclaude/issues/108)) ([cbd28ac](https://github.com/fnclaude/fnclaude/commit/cbd28ac15a53b7c836a4a488ed39d26016469255))

## [2.0.1](https://github.com/fnclaude/fnclaude/compare/fnclaude-v2.0.0...fnclaude-v2.0.1) (2026-05-27)


### Bug Fixes

* **fnclaude:** report umbrella version, not cli version, on --version ([#106](https://github.com/fnclaude/fnclaude/issues/106)) ([815a93d](https://github.com/fnclaude/fnclaude/commit/815a93d883368da19d83c5de4b60f41d0fc6382a))

## [2.0.0](https://github.com/fnclaude/fnclaude/compare/fnclaude-v1.0.0...fnclaude-v2.0.0) (2026-05-27)


### ⚠ BREAKING CHANGES

* **cli:** Version bump to v1.0.0. The API surface is identical to 0.7.8 but pinned dependencies on ^0.7.x should update to ^1.0.0.

### Features

* **cli:** graduate @fnclaude/cli to v1.0.0 ([#101](https://github.com/fnclaude/fnclaude/issues/101)) ([d34bb1f](https://github.com/fnclaude/fnclaude/commit/d34bb1f1a1217d37de82d1c3aa3431eff6a62a3e))

## [1.0.0](https://github.com/fnclaude/fnclaude/compare/fnclaude-v0.0.18...fnclaude-v1.0.0) (2026-05-27)


### Features

* **cli:** ship shell completions + bundle LICENSE in tarballs ([#94](https://github.com/fnclaude/fnclaude/issues/94)) ([9c5cfad](https://github.com/fnclaude/fnclaude/commit/9c5cfad91df69201709b9830b1d5b1de1bec72f9))

## [0.0.18](https://github.com/fnclaude/fnclaude/compare/fnclaude-v0.0.17...fnclaude-v0.0.18) (2026-05-27)


### Bug Fixes

* **fnclaude:** hard-error or re-exec when launched under Node ([#85](https://github.com/fnclaude/fnclaude/issues/85)) ([05422e1](https://github.com/fnclaude/fnclaude/commit/05422e1df364ee81a709de5d5d577b271083d0e4))

## [0.0.17](https://github.com/fnclaude/fnclaude/compare/fnclaude-v0.0.16...fnclaude-v0.0.17) (2026-05-25)


### Bug Fixes

* minor adjustments to trigger [@latest](https://github.com/latest) publishes for all three packages ([#71](https://github.com/fnclaude/fnclaude/issues/71)) ([9957c66](https://github.com/fnclaude/fnclaude/commit/9957c66652ae2fdeaa4fc968e3cf3a3eff5d5a67))

## [0.0.16](https://github.com/fnclaude/fnclaude/compare/fnclaude-v0.0.15...fnclaude-v0.0.16) (2026-05-23)


### Bug Fixes

* **fnclaude:** minor README refinement (recovery republish with cli 0.7.2 deps) ([#64](https://github.com/fnclaude/fnclaude/issues/64)) ([c2030ca](https://github.com/fnclaude/fnclaude/commit/c2030ca10ac65041a2e655361ecc52887e990d45))

## [0.0.15](https://github.com/fnclaude/fnclaude/compare/fnclaude-v0.0.14...fnclaude-v0.0.15) (2026-05-23)


### Bug Fixes

* expand cli + fnclaude READMEs (recovery republish for both) ([#59](https://github.com/fnclaude/fnclaude/issues/59)) ([53b4ae8](https://github.com/fnclaude/fnclaude/commit/53b4ae885a1aa3edabd9251e97e97a1587f20aff))

## [0.0.14](https://github.com/fnclaude/fnclaude/compare/fnclaude-v0.0.13...fnclaude-v0.0.14) (2026-05-23)


### Bug Fixes

* document Bun runtime requirement (re-triggers publish chain) ([#56](https://github.com/fnclaude/fnclaude/issues/56)) ([0a4bb13](https://github.com/fnclaude/fnclaude/commit/0a4bb136d5dd9e8b1984630d42ebdb3ec0c91854))

## [0.0.13](https://github.com/fnclaude/fnclaude/compare/fnclaude-v0.0.12...fnclaude-v0.0.13) (2026-05-23)


### Bug Fixes

* refresh cli and fnclaude READMEs to trigger republish ([#53](https://github.com/fnclaude/fnclaude/issues/53)) ([b687d54](https://github.com/fnclaude/fnclaude/commit/b687d5401a3959e9e4fc34d2c6aee7895174a885))

## [0.0.12](https://github.com/fnclaude/fnclaude/compare/fnclaude-v0.0.11...fnclaude-v0.0.12) (2026-05-23)


### Bug Fixes

* **fnclaude:** refresh README; bumps to republish with current cli/renderer deps ([#48](https://github.com/fnclaude/fnclaude/issues/48)) ([e0c978c](https://github.com/fnclaude/fnclaude/commit/e0c978c1acd7b3b955eafda469bbbe908249646d))

## [0.0.11](https://github.com/fnclaude/fnclaude/compare/fnclaude-v0.0.10...fnclaude-v0.0.11) (2026-05-23)


### Bug Fixes

* add repository field to cli + fnclaude package.json for OIDC provenance ([#30](https://github.com/fnclaude/fnclaude/issues/30)) ([65b1e83](https://github.com/fnclaude/fnclaude/commit/65b1e83c3c35ae4b9c99762b6c76b86fc41ce7fc))

## [0.0.10](https://github.com/fnclaude/fnclaude/compare/fnclaude-v0.0.9...fnclaude-v0.0.10) (2026-05-23)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @fnclaude/cli bumped to 0.1.0
    * @fnclaude/renderer bumped to 2.0.1

## [0.0.9](https://github.com/fnclaude/fnclaude/compare/fnclaude-v0.0.8...fnclaude-v0.0.9) (2026-05-23)


### Bug Fixes

* **release-please:** reset manifest + clear phantom CHANGELOG entries ([#15](https://github.com/fnclaude/fnclaude/issues/15)) ([dc7eaa1](https://github.com/fnclaude/fnclaude/commit/dc7eaa146cf610b584aa121a4ba99475d9c97051))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @fnclaude/cli bumped to 0.1.0
    * @fnclaude/renderer bumped to 2.0.1

## Changelog
