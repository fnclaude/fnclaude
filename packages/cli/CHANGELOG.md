# Changelog

## [0.7.3](https://github.com/fnclaude/fnclaude/compare/cli-v0.7.2...cli-v0.7.3) (2026-05-25)


### Bug Fixes

* minor adjustments to trigger [@latest](https://github.com/latest) publishes for all three packages ([#71](https://github.com/fnclaude/fnclaude/issues/71)) ([9957c66](https://github.com/fnclaude/fnclaude/commit/9957c66652ae2fdeaa4fc968e3cf3a3eff5d5a67))

## [0.7.2](https://github.com/fnclaude/fnclaude/compare/cli-v0.7.1...cli-v0.7.2) (2026-05-23)


### Bug Fixes

* **cli:** expand README with Quick Start and Key Features sections ([#62](https://github.com/fnclaude/fnclaude/issues/62)) ([616cde1](https://github.com/fnclaude/fnclaude/commit/616cde1805685982b7bb182fbd48fbebfdc12262))
* document Bun runtime requirement (re-triggers publish chain) ([#56](https://github.com/fnclaude/fnclaude/issues/56)) ([0a4bb13](https://github.com/fnclaude/fnclaude/commit/0a4bb136d5dd9e8b1984630d42ebdb3ec0c91854))
* expand cli + fnclaude READMEs (recovery republish for both) ([#59](https://github.com/fnclaude/fnclaude/issues/59)) ([53b4ae8](https://github.com/fnclaude/fnclaude/commit/53b4ae885a1aa3edabd9251e97e97a1587f20aff))
* refresh cli and fnclaude READMEs to trigger republish ([#53](https://github.com/fnclaude/fnclaude/issues/53)) ([b687d54](https://github.com/fnclaude/fnclaude/commit/b687d5401a3959e9e4fc34d2c6aee7895174a885))

## [0.7.1](https://github.com/fnclaude/fnclaude/compare/cli-v0.7.0...cli-v0.7.1) (2026-05-23)


### Bug Fixes

* **cli:** read version from package.json instead of hardcoded "dev" ([#50](https://github.com/fnclaude/fnclaude/issues/50)) ([08276ed](https://github.com/fnclaude/fnclaude/commit/08276ed969e0f4fc6b8a3fe927e32e50ddeb7647))

## [0.7.0](https://github.com/fnclaude/fnclaude/compare/cli-v0.6.0...cli-v0.7.0) (2026-05-23)


### Features

* **cli:** port main run loop + silentRelaunch/Handoff from Go ([#43](https://github.com/fnclaude/fnclaude/issues/43)) ([26da1f3](https://github.com/fnclaude/fnclaude/commit/26da1f315fab8f8964b5dda19d7eb21f2ca85764))

## [0.6.0](https://github.com/fnclaude/fnclaude/compare/cli-v0.5.0...cli-v0.6.0) (2026-05-23)


### Features

* **cli:** port PTY runner + cross-cwd detection from Go ([#39](https://github.com/fnclaude/fnclaude/issues/39)) ([47f2c4e](https://github.com/fnclaude/fnclaude/commit/47f2c4eaa82deaf5861f3ad92a4a229eb291e664))

## [0.5.0](https://github.com/fnclaude/fnclaude/compare/cli-v0.4.0...cli-v0.5.0) (2026-05-23)


### Features

* **cli:** port autoname + clipboard from Go ([#36](https://github.com/fnclaude/fnclaude/issues/36)) ([6d9394b](https://github.com/fnclaude/fnclaude/commit/6d9394b34848788a1e0eef569c8cfe031ae6e8c9))

## [0.4.0](https://github.com/fnclaude/fnclaude/compare/cli-v0.3.0...cli-v0.4.0) (2026-05-23)


### Features

* **cli:** port argv builder + worktree intercept from Go ([#38](https://github.com/fnclaude/fnclaude/issues/38)) ([2734684](https://github.com/fnclaude/fnclaude/commit/27346841a04d74072dde1a00537152f2827a081e))

## [0.3.0](https://github.com/fnclaude/fnclaude/compare/cli-v0.2.0...cli-v0.3.0) (2026-05-23)


### Features

* **cli:** port spawn sibling + template substitution from Go ([#35](https://github.com/fnclaude/fnclaude/issues/35)) ([1014901](https://github.com/fnclaude/fnclaude/commit/101490177d0414f4276c5e99b30a07a6ecf70755))

## [0.2.0](https://github.com/fnclaude/fnclaude/compare/cli-v0.1.1...cli-v0.2.0) (2026-05-23)


### Features

* **cli:** port MCP protocol + listener + client subprocess from Go ([#33](https://github.com/fnclaude/fnclaude/issues/33)) ([abae712](https://github.com/fnclaude/fnclaude/commit/abae7125e4b4a2bbf255f6d18ca4285a910e6c93))

## [0.1.1](https://github.com/fnclaude/fnclaude/compare/cli-v0.1.0...cli-v0.1.1) (2026-05-23)


### Bug Fixes

* add repository field to cli + fnclaude package.json for OIDC provenance ([#30](https://github.com/fnclaude/fnclaude/issues/30)) ([65b1e83](https://github.com/fnclaude/fnclaude/commit/65b1e83c3c35ae4b9c99762b6c76b86fc41ce7fc))

## [0.1.0](https://github.com/fnclaude/fnclaude/compare/cli-v0.0.1...cli-v0.1.0) (2026-05-23)


### Features

* **cli:** port arg parser + resolver from Go ([#20](https://github.com/fnclaude/fnclaude/issues/20)) ([3e49e18](https://github.com/fnclaude/fnclaude/commit/3e49e18d87b328bbeaa4c527758d2f760efc3b94))
* **cli:** port config/settings/handoff/session-state from Go ([#19](https://github.com/fnclaude/fnclaude/issues/19)) ([8d19bac](https://github.com/fnclaude/fnclaude/commit/8d19bace786a56158a0152e100457cc63b6a3aec))
* **cli:** port path/sanitize/repo-ref/prompts from Go ([#18](https://github.com/fnclaude/fnclaude/issues/18)) ([de1ddf9](https://github.com/fnclaude/fnclaude/commit/de1ddf92d173984102c9247f0fc93a65c34aeef7))
