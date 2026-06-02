# Changelog

## [2.7.3](https://github.com/fnclaude/fnclaude/compare/cli-v2.7.2...cli-v2.7.3) (2026-06-02)


### Bug Fixes

* **cli:** gate compact follow_up on a fixed timer instead of JSONL growth ([#202](https://github.com/fnclaude/fnclaude/issues/202)) ([dbdb094](https://github.com/fnclaude/fnclaude/commit/dbdb0943c094c067dfa7a0bb3ccf3676ad1a6ac5))

## [2.7.2](https://github.com/fnclaude/fnclaude/compare/cli-v2.7.1...cli-v2.7.2) (2026-06-01)


### Bug Fixes

* **cli:** re-arm context-compact notice + drain-queue nudge ([#198](https://github.com/fnclaude/fnclaude/issues/198)) ([7715c16](https://github.com/fnclaude/fnclaude/commit/7715c16cdcb8eb6415fbc6bf0afe8c1face58d25))

## [2.7.1](https://github.com/fnclaude/fnclaude/compare/cli-v2.7.0...cli-v2.7.1) (2026-05-30)


### Bug Fixes

* **cli:** submit injected TUI commands instead of parking them in the box ([#193](https://github.com/fnclaude/fnclaude/issues/193)) ([3db3223](https://github.com/fnclaude/fnclaude/commit/3db3223d75f8ad75fe52667b28d6ca0c14bcd6a7))

## [2.7.0](https://github.com/fnclaude/fnclaude/compare/cli-v2.6.0...cli-v2.7.0) (2026-05-30)


### Features

* **cli:** add file-only structured logging for the launcher ([#194](https://github.com/fnclaude/fnclaude/issues/194)) ([c8f0e64](https://github.com/fnclaude/fnclaude/commit/c8f0e64e3a1bdeabf8151f854543cf20c2b92b9a))

## [2.6.0](https://github.com/fnclaude/fnclaude/compare/cli-v2.5.1...cli-v2.6.0) (2026-05-30)


### Features

* **cli:** bootstrap a fresh repo when a clone target doesn't exist ([#189](https://github.com/fnclaude/fnclaude/issues/189)) ([f15bb4b](https://github.com/fnclaude/fnclaude/commit/f15bb4bb70c08886d62e5f2651aeecc0f03d8c2b))

## [2.5.1](https://github.com/fnclaude/fnclaude/compare/cli-v2.5.0...cli-v2.5.1) (2026-05-30)


### Bug Fixes

* **cli:** treat ., .., ./x, ../x as paths, not ambiguous repo refs ([#187](https://github.com/fnclaude/fnclaude/issues/187)) ([e6b7f56](https://github.com/fnclaude/fnclaude/commit/e6b7f568550dfaf6ed818714b8a1b536e55bda3d))

## [2.5.0](https://github.com/fnclaude/fnclaude/compare/cli-v2.4.0...cli-v2.5.0) (2026-05-29)


### Features

* **cli:** get_usage MCP tool + budget.md fragment ([#184](https://github.com/fnclaude/fnclaude/issues/184)) ([f802c32](https://github.com/fnclaude/fnclaude/commit/f802c32ed5d76326d23b31718df73f67a1c52460))

## [2.4.0](https://github.com/fnclaude/fnclaude/compare/cli-v2.3.0...cli-v2.4.0) (2026-05-29)


### Features

* **cli:** context-size monitor with one-shot compaction notice ([#182](https://github.com/fnclaude/fnclaude/issues/182)) ([898494b](https://github.com/fnclaude/fnclaude/commit/898494b1ee9a56386252e4b4affa1ad5d2d2f574))

## [2.3.0](https://github.com/fnclaude/fnclaude/compare/cli-v2.2.0...cli-v2.3.0) (2026-05-29)


### Features

* **cli:** four slash-injection MCP tools over the C0 keystone ([#180](https://github.com/fnclaude/fnclaude/issues/180)) ([aa1e5b0](https://github.com/fnclaude/fnclaude/commit/aa1e5b05e111e977a1526aaf124801fdfa01f1fd))

## [2.2.0](https://github.com/fnclaude/fnclaude/compare/cli-v2.1.0...cli-v2.2.0) (2026-05-29)


### Features

* **cli:** add session-usage reader (tokens, cost, context from JSONL) ([#178](https://github.com/fnclaude/fnclaude/issues/178)) ([0367602](https://github.com/fnclaude/fnclaude/commit/03676026b2d146b471512d0c92dd0236c2372403))

## [2.1.0](https://github.com/fnclaude/fnclaude/compare/cli-v2.0.6...cli-v2.1.0) (2026-05-29)


### Features

* **cli:** slash-injection keystone for parent-dispatch MCP tools ([#175](https://github.com/fnclaude/fnclaude/issues/175)) ([b0e30bb](https://github.com/fnclaude/fnclaude/commit/b0e30bb3ed2d48b2defacb96a55ac141320177e2))

## [2.0.6](https://github.com/fnclaude/fnclaude/compare/cli-v2.0.5...cli-v2.0.6) (2026-05-29)


### Bug Fixes

* **cli:** disambiguate bare repo names found under multiple owners ([#173](https://github.com/fnclaude/fnclaude/issues/173)) ([b33a039](https://github.com/fnclaude/fnclaude/commit/b33a03978835a84bca29c09d87d2a8ea2a843dc7))

## [2.0.5](https://github.com/fnclaude/fnclaude/compare/cli-v2.0.4...cli-v2.0.5) (2026-05-29)


### Bug Fixes

* **cli:** stamp relaunch argv into FNC_ARGS_JSON so resume can't loop ([#166](https://github.com/fnclaude/fnclaude/issues/166)) ([2a36523](https://github.com/fnclaude/fnclaude/commit/2a36523ef997e0cbfb114c5dd265c8bc5ef6b137))

## [2.0.4](https://github.com/fnclaude/fnclaude/compare/cli-v2.0.3...cli-v2.0.4) (2026-05-29)


### Bug Fixes

* **cli:** fix cross-cwd resume — quoted paths, screen clear, picker loop ([#164](https://github.com/fnclaude/fnclaude/issues/164)) ([8f02bc9](https://github.com/fnclaude/fnclaude/commit/8f02bc94c0f1c92030cdd6754432ca8efb2592df))

## [2.0.3](https://github.com/fnclaude/fnclaude/compare/cli-v2.0.2...cli-v2.0.3) (2026-05-29)


### Bug Fixes

* **cli:** defer tty teardown to handoff awaiter on MCP restart ([#161](https://github.com/fnclaude/fnclaude/issues/161)) ([a41251e](https://github.com/fnclaude/fnclaude/commit/a41251edcf27b4e847d7c0391fe34a1639934c69))

## [2.0.2](https://github.com/fnclaude/fnclaude/compare/cli-v2.0.1...cli-v2.0.2) (2026-05-29)


### Bug Fixes

* **cli:** strip FNC_ARGS_JSON from claude child env ([#158](https://github.com/fnclaude/fnclaude/issues/158)) ([e2726e6](https://github.com/fnclaude/fnclaude/commit/e2726e6a2b4eb14f7015fa663a82ccba0c6245cf))

## [2.0.1](https://github.com/fnclaude/fnclaude/compare/cli-v2.0.0...cli-v2.0.1) (2026-05-28)


### Bug Fixes

* **cli:** restore MCP self-server (initialize handshake + arg ordering past --) ([#156](https://github.com/fnclaude/fnclaude/issues/156)) ([a242d97](https://github.com/fnclaude/fnclaude/commit/a242d97c1dbabd6a5c6ddba678225e98dd6fda44))

## [2.0.0](https://github.com/fnclaude/fnclaude/compare/cli-v1.1.1...cli-v2.0.0) (2026-05-28)


### ⚠ BREAKING CHANGES

* **cli:** wipe src + minimal Bun launcher (noop dir, stdio inherit)

### Features

* **cli:** --help / --version short-circuits (§2.6) ([6668b82](https://github.com/fnclaude/fnclaude/commit/6668b822e60f571825afacd3a346790a9fcea7cf))
* **cli:** '--' sentinel helpers (§2.5) ([d2dc68b](https://github.com/fnclaude/fnclaude/commit/d2dc68b5ed421a185d9803508341f0cbd0b8d609))
* **cli:** 'mcp' subcommand dispatch (stub) + preflight directive error (§2.7) ([5627c8d](https://github.com/fnclaude/fnclaude/commit/5627c8d195267ae55c7521d20ef4103a1c9f80c1))
* **cli:** 64KB ring buffer for PTY tee (§9.1) ([#141](https://github.com/fnclaude/fnclaude/issues/141)) ([04b417b](https://github.com/fnclaude/fnclaude/commit/04b417bf8c36b6add0c3ea90af5e83e67c656f1a))
* **cli:** AF_UNIX MCP listener startup (§7.2) ([#137](https://github.com/fnclaude/fnclaude/issues/137)) ([be4aae2](https://github.com/fnclaude/fnclaude/commit/be4aae20ddfbbec63b39f7123d1be6ddd0cfd69d))
* **cli:** Anthropic SDK fast-path for auto-naming (§5.2) ([#128](https://github.com/fnclaude/fnclaude/issues/128)) ([bcb3fed](https://github.com/fnclaude/fnclaude/commit/bcb3fedb21c5f0227b068583273cac20781407a5))
* **cli:** argv intake + node-&gt;bun preflight (§2.1) ([add8809](https://github.com/fnclaude/fnclaude/commit/add88099d54ba0c0c9cf61d673339e3f9815d017))
* **cli:** auto-tmux gating (§5.4) ([ca3142a](https://github.com/fnclaude/fnclaude/commit/ca3142afec3d46903f86b1a1224d4cd6a98f14f0))
* **cli:** autoName orchestrator (§5.2) ([f1fb843](https://github.com/fnclaude/fnclaude/commit/f1fb843e179546c2c6a7b9b5426058808f34180b))
* **cli:** bash completion (§10.1) ([#130](https://github.com/fnclaude/fnclaude/issues/130)) ([1b487a5](https://github.com/fnclaude/fnclaude/commit/1b487a5244f79f9aa89b509de2bd439887ce0385))
* **cli:** clone preparation — URL + destination path (§3.4c-pre) ([43c2d67](https://github.com/fnclaude/fnclaude/commit/43c2d67586f9543a0ff67b46cc70f2bb3d4e2660))
* **cli:** cloneTemplate substitution (§3.4b) ([5d4eb0e](https://github.com/fnclaude/fnclaude/commit/5d4eb0e513f827645fbfcadda4979ed4a2104937))
* **cli:** cross-cwd resume hint parser (§9.2) ([#139](https://github.com/fnclaude/fnclaude/issues/139)) ([8ae0a0d](https://github.com/fnclaude/fnclaude/commit/8ae0a0d2b65111533474d36c84943880f7af3af7))
* **cli:** cross-cwd silent relaunch (§9.3) ([#149](https://github.com/fnclaude/fnclaude/issues/149)) ([aa0120f](https://github.com/fnclaude/fnclaude/commit/aa0120f822844923c3758a9ecedef3f789edd089))
* **cli:** deferred-flush warnings buffer (§10.3) ([#127](https://github.com/fnclaude/fnclaude/issues/127)) ([a3f4585](https://github.com/fnclaude/fnclaude/commit/a3f4585beb76e94c43277ece16cb55afdbd55c4f))
* **cli:** ensureCwd phantom-directory fabrication (§6.3) ([7288a5f](https://github.com/fnclaude/fnclaude/commit/7288a5f884720c60c4bff3cc3530205a9f0813eb))
* **cli:** env composition for child claude (§6.1) ([b36f396](https://github.com/fnclaude/fnclaude/commit/b36f396687ca69a0edcc8665731da32d5847a414))
* **cli:** expand model + effort magic into passthrough (§4.1-4.3) ([994cf9b](https://github.com/fnclaude/fnclaude/commit/994cf9be89a1debea48e42979a080b73f7bb29c0))
* **cli:** expand subcommand magic into passthrough (§4.4) ([0ac2bf4](https://github.com/fnclaude/fnclaude/commit/0ac2bf41816b4d8d120cf4722478e56b7a9ceb3a))
* **cli:** fish completion (§10.1) ([#132](https://github.com/fnclaude/fnclaude/issues/132)) ([6ae92c7](https://github.com/fnclaude/fnclaude/commit/6ae92c7c0144378242b10f8258ab9e7d79cbf667))
* **cli:** fnc_copy_to_clipboard handler (§8.4) ([#142](https://github.com/fnclaude/fnclaude/issues/142)) ([591e520](https://github.com/fnclaude/fnclaude/commit/591e520f855166fb43653c779c80d9c6bbe3b39d))
* **cli:** fnc_restart handler + wire clipboard (§8.1) ([#146](https://github.com/fnclaude/fnclaude/issues/146)) ([a889248](https://github.com/fnclaude/fnclaude/commit/a889248be3d76f1c8e661bb7564426112cdfa8b9))
* **cli:** fnc_spawn_session handler (§8.3) ([#148](https://github.com/fnclaude/fnclaude/issues/148)) ([d06fbdd](https://github.com/fnclaude/fnclaude/commit/d06fbddc03ee40881e8154d1462f1df823ebd89a))
* **cli:** fnc_switch_project handler (§8.2) ([#147](https://github.com/fnclaude/fnclaude/issues/147)) ([675d8e2](https://github.com/fnclaude/fnclaude/commit/675d8e2773aaf3bdc133f91660d162376fb3583c))
* **cli:** four-tier repoSettings loader (§3.4 settings) ([413cf40](https://github.com/fnclaude/fnclaude/commit/413cf40908ce48d2a7385d0e8bc01451c43d5bbe))
* **cli:** full argv parser - positionals, fnclaude-eaten flags, passthrough (§2.4) ([a29d7c6](https://github.com/fnclaude/fnclaude/commit/a29d7c6d3b051bcc4ad9fcc2a4de9f69f1963677))
* **cli:** gh CLI orchestration for bare-name + clone (§3.4c) ([3def11a](https://github.com/fnclaude/fnclaude/commit/3def11a11df443317d173c789d79f07223cde740))
* **cli:** handoff trigger + kill+re-exec machinery (§8.5) ([#145](https://github.com/fnclaude/fnclaude/issues/145)) ([9608f6a](https://github.com/fnclaude/fnclaude/commit/9608f6a3d9c0c9307395664990f8469d77139f15))
* **cli:** host-aliases LUT loader (§3.4 settings) ([5e34078](https://github.com/fnclaude/fnclaude/commit/5e34078313ae7e0f0701d682415e3caa12d4337a))
* **cli:** launcher polish — help refresh, exec.env marker, --no-tmux guard (§10.2/4/5) ([#135](https://github.com/fnclaude/fnclaude/issues/135)) ([71e0504](https://github.com/fnclaude/fnclaude/commit/71e0504cfca2ad9175396b227c1dc65c7c6205fa))
* **cli:** magic-positional state machine (§2.3) ([a76875d](https://github.com/fnclaude/fnclaude/commit/a76875d3acf6de7900b23cd6690a5f50a2f56b51))
* **cli:** MCP JSON-RPC 2.0 server scaffold (§7.3) ([#134](https://github.com/fnclaude/fnclaude/issues/134)) ([b6c69b2](https://github.com/fnclaude/fnclaude/commit/b6c69b2c7b79e55e9a30c2c6058d339c22fd564c))
* **cli:** MCP socket path computation (§7.1) ([#126](https://github.com/fnclaude/fnclaude/issues/126)) ([d7ccfb0](https://github.com/fnclaude/fnclaude/commit/d7ccfb0635f2d6b9193e13ec88f5f7253d258282))
* **cli:** MCP subprocess entry point + AF_UNIX wire format (§7.5, §7.6) ([#136](https://github.com/fnclaude/fnclaude/issues/136)) ([e2259e4](https://github.com/fnclaude/fnclaude/commit/e2259e4ffcd47c10db42b84aa965e392bb948927))
* **cli:** name sanitization for path safety (§5.1) ([5825e1d](https://github.com/fnclaude/fnclaude/commit/5825e1db44465d9057118a86bff21d349e878f85))
* **cli:** parseRepoRef + ref helpers (§3.4a) ([ace52f5](https://github.com/fnclaude/fnclaude/commit/ace52f573ef339bb17462a40362845c9edfbc172))
* **cli:** PATH check for claude binary (§6.2) ([b7c1896](https://github.com/fnclaude/fnclaude/commit/b7c18969aeba6a1c5e5bc86d9a11a68cfcba6bbc))
* **cli:** path resolution basics - tilde, abs, noop fallback (§3.1-3.3) ([80cfde3](https://github.com/fnclaude/fnclaude/commit/80cfde3142d771b7c33b2aaf80c9475c92fda38f))
* **cli:** per-tool MCP dispatch on parent side (§7.7) ([#140](https://github.com/fnclaude/fnclaude/issues/140)) ([ff3c03a](https://github.com/fnclaude/fnclaude/commit/ff3c03a255d5f4b5190a80b924970b695b1d792d))
* **cli:** port live permission-mode reader and wire handlers ([#151](https://github.com/fnclaude/fnclaude/issues/151)) ([6811656](https://github.com/fnclaude/fnclaude/commit/68116563dd6956e6c0197dd9e16074320cf68493))
* **cli:** preserveArgs + applyOverrides shared utility ([#143](https://github.com/fnclaude/fnclaude/issues/143)) ([e4e625d](https://github.com/fnclaude/fnclaude/commit/e4e625dc549e03b4c91fa6e9ee01c14fc48029bf))
* **cli:** prompt-fragment selection, load, and injection (§5.5) ([ebeb7bc](https://github.com/fnclaude/fnclaude/commit/ebeb7bc5ccaa2c4696f3e0d028872cc9717a1da7))
* **cli:** prompts directory resolver (§5.5) ([0c2efbd](https://github.com/fnclaude/fnclaude/commit/0c2efbd5e0f888b8c1d9f07b66fb95547a3b9836))
* **cli:** pure pieces of auto-name (§5.2 foundations) ([e3a9b73](https://github.com/fnclaude/fnclaude/commit/e3a9b73f134a325210de9f0bd37c21666ba01d79))
* **cli:** resolver orchestrator (§3.4c + §3.5 propagation) ([98317c5](https://github.com/fnclaude/fnclaude/commit/98317c5b705334ea0b58f06a196c339e18af35b5))
* **cli:** seed handoff.template.md into noop dir (§10.7) ([#129](https://github.com/fnclaude/fnclaude/issues/129)) ([bcf23a1](https://github.com/fnclaude/fnclaude/commit/bcf23a10a1c9ce0400cb68892acbba70ebb18d57))
* **cli:** self-MCP --mcp-config injection (§7.4) ([#144](https://github.com/fnclaude/fnclaude/issues/144)) ([2a24fde](https://github.com/fnclaude/fnclaude/commit/2a24fdee28cfd7b4c8b7c5d222dbba2646a89b9b))
* **cli:** short-flag cluster translation (§4.5) ([b573940](https://github.com/fnclaude/fnclaude/commit/b5739402f67a30483a7d9fc0904a138c7107e4c5))
* **cli:** switch launcher to Bun.Terminal for cross-cwd resume capture (§9.0) ([#138](https://github.com/fnclaude/fnclaude/issues/138)) ([adb6171](https://github.com/fnclaude/fnclaude/commit/adb617149a2defe852798f342cf697a08e87f303))
* **cli:** token classifier for argv (§2.2) ([bc00e71](https://github.com/fnclaude/fnclaude/commit/bc00e71ce143dcb5c646cbed2276f8ce3c0a3583))
* **cli:** wire +workspace suffix into worktree intercept (§3.5) ([3f23bbe](https://github.com/fnclaude/fnclaude/commit/3f23bbedca6b81cde224bd0a36f53536daa7fec0))
* **cli:** wire auto-name into main (§5.2) ([a65f559](https://github.com/fnclaude/fnclaude/commit/a65f559d64a799809834c8108532ba27411d665f))
* **cli:** wire auto-tmux gating + config loader (§5.4) ([3830e0a](https://github.com/fnclaude/fnclaude/commit/3830e0ab2d522b2af38b282f479ab6e83393fda7))
* **cli:** wire parseArgs + expand + cwd resolution into main (§6 MVP) ([7d3cbcb](https://github.com/fnclaude/fnclaude/commit/7d3cbcbfa5c98c914f2cc17480e41fec2ceecd61))
* **cli:** wire prompt-fragment injection into main (§5.5) ([4c33ed5](https://github.com/fnclaude/fnclaude/commit/4c33ed58786c8155507bb0e002a0f8e9116dc9cb))
* **cli:** wire settings + resolveInput into main (§3.4 + §6.1) ([4c593af](https://github.com/fnclaude/fnclaude/commit/4c593afa32f76d24c67a06f1a337f8b069fcc096))
* **cli:** wire worktree intercept into main (§5.3) ([4f121f0](https://github.com/fnclaude/fnclaude/commit/4f121f0adfe6b449afe2a5cad663483e0fa4b5af))
* **cli:** worktree intercept (§5.3) ([2a74256](https://github.com/fnclaude/fnclaude/commit/2a742563189b6a5831d716d21d603ec9f418b2d2))
* **cli:** zsh completion (§10.1) ([#131](https://github.com/fnclaude/fnclaude/issues/131)) ([1a96431](https://github.com/fnclaude/fnclaude/commit/1a964316345aa5773cb7c9aa70ed76af7762a054))


### Refactoring

* **cli:** wipe src + minimal Bun launcher (noop dir, stdio inherit) ([f89022f](https://github.com/fnclaude/fnclaude/commit/f89022fe6d9c73bc4c5d7e6189f8e890f506c54c))

## [1.1.1](https://github.com/fnclaude/fnclaude/compare/cli-v1.1.0...cli-v1.1.1) (2026-05-27)


### Bug Fixes

* **cli:** place --append-system-prompt before `--` sentinel ([#117](https://github.com/fnclaude/fnclaude/issues/117)) ([a848455](https://github.com/fnclaude/fnclaude/commit/a84845589ccc6bb71cfa90313696f454ef4445d0))

## [1.1.0](https://github.com/fnclaude/fnclaude/compare/cli-v1.0.1...cli-v1.1.0) (2026-05-27)


### Features

* **cli:** own the Bun argv-stripping shim; collapse umbrella to thin delegator ([#112](https://github.com/fnclaude/fnclaude/issues/112)) ([84a6655](https://github.com/fnclaude/fnclaude/commit/84a66553bce93924bba6a87cba6c5a43114f19d3))

## [1.0.1](https://github.com/fnclaude/fnclaude/compare/cli-v1.0.1...cli-v1.0.1) (2026-05-27)


### Features

* **cli:** own the Bun argv-stripping shim; collapse umbrella to thin delegator ([#112](https://github.com/fnclaude/fnclaude/issues/112)) ([84a6655](https://github.com/fnclaude/fnclaude/commit/84a66553bce93924bba6a87cba6c5a43114f19d3))

## [1.0.1](https://github.com/fnclaude/fnclaude/compare/cli-v1.0.0...cli-v1.0.1) (2026-05-27)


### Bug Fixes

* **fnclaude,cli:** pass argv via env var to bypass Bun's -- stripping ([#108](https://github.com/fnclaude/fnclaude/issues/108)) ([cbd28ac](https://github.com/fnclaude/fnclaude/commit/cbd28ac15a53b7c836a4a488ed39d26016469255))

## [1.0.0](https://github.com/fnclaude/fnclaude/compare/cli-v0.7.8...cli-v1.0.0) (2026-05-27)


### ⚠ BREAKING CHANGES

* **cli:** Version bump to v1.0.0. The API surface is identical to 0.7.8 but pinned dependencies on ^0.7.x should update to ^1.0.0.

### Features

* **cli:** graduate @fnclaude/cli to v1.0.0 ([#101](https://github.com/fnclaude/fnclaude/issues/101)) ([d34bb1f](https://github.com/fnclaude/fnclaude/commit/d34bb1f1a1217d37de82d1c3aa3431eff6a62a3e))

## [0.7.8](https://github.com/fnclaude/fnclaude/compare/cli-v0.7.7...cli-v0.7.8) (2026-05-27)


### Bug Fixes

* **cli:** bundle host-aliases defaults in source so npm install works ([#93](https://github.com/fnclaude/fnclaude/issues/93)) ([c70e6d8](https://github.com/fnclaude/fnclaude/commit/c70e6d861da9f0e2892e7c1673ef9849ac37db7c))

## [0.7.7](https://github.com/fnclaude/fnclaude/compare/cli-v0.7.6...cli-v0.7.7) (2026-05-27)


### Bug Fixes

* **cli:** resolve prompts via module location so umbrella install works ([#92](https://github.com/fnclaude/fnclaude/issues/92)) ([7312592](https://github.com/fnclaude/fnclaude/commit/7312592df2496aa702ff28c1f167579b14732f3e))
* **cli:** three security fixes from review (socket mode, request validation, cwd anchor) ([#79](https://github.com/fnclaude/fnclaude/issues/79)) ([819980d](https://github.com/fnclaude/fnclaude/commit/819980d9520be53b5ad7c405d5d8305cf6d05898))

## [0.7.6](https://github.com/fnclaude/fnclaude/compare/cli-v0.7.5...cli-v0.7.6) (2026-05-27)


### Bug Fixes

* **cli:** drop `--`+trailing prompt tokens in preserveArgs ([#80](https://github.com/fnclaude/fnclaude/issues/80)) ([9aa5704](https://github.com/fnclaude/fnclaude/commit/9aa5704423d2583c74f4f028d82ece815246b4ea))

## [0.7.5](https://github.com/fnclaude/fnclaude/compare/cli-v0.7.4...cli-v0.7.5) (2026-05-27)


### Bug Fixes

* **cli:** ship prompts/ in package and bump node-pty for Linux prebuilds ([#83](https://github.com/fnclaude/fnclaude/issues/83)) ([0294c23](https://github.com/fnclaude/fnclaude/commit/0294c2388f70b063361fffdf991d78affe9cad76))

## [0.7.4](https://github.com/fnclaude/fnclaude/compare/cli-v0.7.3...cli-v0.7.4) (2026-05-27)


### Bug Fixes

* **cli:** inject resume-continue system-reminder on fnc_restart ([#84](https://github.com/fnclaude/fnclaude/issues/84)) ([7fdaa2c](https://github.com/fnclaude/fnclaude/commit/7fdaa2c169d49e6454ac020e8f820d70e103b166)), closes [#77](https://github.com/fnclaude/fnclaude/issues/77)

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
