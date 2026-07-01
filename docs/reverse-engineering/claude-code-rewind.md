# Claude Code rewind (file checkpointing + conversation rewind)

A behavior-level reference for Claude Code's **rewind** feature — the `/rewind`
slash command and its `Esc Esc` double-tap shortcut, the file-checkpointing
mechanism that backs the "code" arm, the conversation-truncation that backs the
"conversation" arm, and the hidden `--rewind-files` headless flag. Written
against **v2.1.197** of the Bun-compiled ELF at
`~/.local/share/mise/installs/node/<ver>/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`,
cross-checked against the `@anthropic-ai/claude-agent-sdk` type definitions
(`sdk.d.ts`, package v0.3.193 in the local Bun cache) which expose the same
machinery as a typed programmatic API.

> Minified symbol names and byte offsets are intentionally omitted — they are
> build-specific noise that changes every release. All findings are anchored on
> durable anchors: string literals, telemetry event names, config keys, SDK type
> definitions, on-disk paths, `--help` observations, and empirically-reproduced
> CLI behavior. See the sibling [`claude-code-binary-internals.md`](claude-code-binary-internals.md)
> for the `grep -aboF` + `dd`-window grep technique, and
> [`extract-claude-code-prompts.sh`](extract-claude-code-prompts.sh) /
> [`claude-code-prompt-strings.md`](claude-code-prompt-strings.md) for the cached
> string extraction most of these anchors were pulled from.

Cross-references (do not duplicate): [`claude-code-agent-ui-internals.md`](claude-code-agent-ui-internals.md)
for how the transcript view (which the conversation-rewind arm truncates) is
structured, and [`claude-remote-control.md`](claude-remote-control.md) for the
SDK control-request channel that also carries the rewind requests documented
below.

---

## What rewind is

Rewind lets you roll a session back to an earlier point. There are **two entry
points to the same picker**:

- The `/rewind` slash command (registered with the description
  **"Restore the code and/or conversation to a previous point"**).
- The `Esc Esc` double-tap keyboard shortcut. The tips-tour "Undo anything" card
  (tagline `/rewind, Esc-Esc`) states it directly:
  > "Claude checkpoints your files before every edit. Press `Esc Esc`
  > (double-tap) to open `/rewind` and roll back to any prior state — code,
  > conversation, or both."

The picker offers a **3-way choice** — restore *code only*, *conversation only*,
or *both*. The strongest in-binary anchor for the three-way shape is the pair of
double-tap hint strings, which vary by whether checkpointing is available:

- `Double-tap esc to rewind the conversation to a previous point in time`
- `Double-tap esc to rewind the code and/or conversation to a previous point in time`

The second variant (adding the "code and/or") is what appears when file
checkpointing is enabled; the first is the conversation-only fallback. This
tells us the **conversation arm is always available**, while the **code arm is
gated on file checkpointing being on**. The slash-command description
("code and/or conversation") and the tips card ("code, conversation, or both")
corroborate the three options. (Note: the picker renders its option labels via
React composition, so discrete literal strings like "Code only" / "Conversation
only" are **not** present as standalone anchors — the three-way claim rests on
the hint/description/tour strings above, not on per-option label literals.)

Whichever arm you pick:

- **Code** = restore the working-tree files to the snapshot taken as of the
  chosen user message (the file-checkpoint / "FileHistory" mechanism below).
- **Conversation** = truncate the transcript back to the chosen user message,
  dropping everything after it from the active context. This is a distinct
  control path from the file restore (see the two SDK control requests below).

### It is deliberately separate from git

The tips card's closing line — used both in the tour and as a standalone
`/rewind` blurb — is the design statement:

> "Went down the wrong path? Rewind to before the detour and try a different
> prompt. **Your git history stays clean.**"

Rewind never touches `.git`. The file backups live entirely outside the working
tree (in `~/.claude/`, see storage model below), so restoring a file is a plain
copy-back, not a `git checkout` / `git reset`, and leaves no commits, no reflog
churn, and no staged changes. This is why it works fine in a repo with a dirty
tree, in a non-git directory, or across multiple unrelated files at once.

---

## The file-checkpoint mechanism ("FileHistory")

The code-rewind arm is backed by a subsystem the binary refers to internally as
**FileHistory** (durable anchor: error strings prefixed `FileHistory:`, e.g.
`FileHistory: Error finding the backup file to apply`,
`FileHistory: Failed to copy backups on restore (no previous session id)`,
`FileHistory: No need to copy file history for resuming with same session id:`,
`FileHistory: Error copying over backup from previous session`).

The SDK documents the same mechanism as a first-class option:

> `enableFileCheckpointing?: boolean` — "Enable file checkpointing to track file
> changes during the session. When enabled, files can be rewound to their state
> at any user message using `Query.rewindFiles()`. File checkpointing creates
> backups of files before they are modified, allowing you to restore them to
> previous states."

The interactive TUI exposes the same toggle as a config key:
`fileCheckpointingEnabled` — documented in the settings type as
**"Snapshot files before edits so /rewind can restore them."**

### What is snapshotted, and when

Before Claude's own file-mutating tools (Write/Edit and friends) touch a file,
FileHistory copies the *current* on-disk content aside as a backup. The
telemetry event enum makes the lifecycle explicit (all `tengu_file_history_*`):

| Event | Meaning |
|---|---|
| `tengu_file_history_snapshot_success` / `_failed` | a checkpoint snapshot was taken (or failed) |
| `tengu_file_history_backup_file_created` | a pre-edit backup blob was written |
| `tengu_file_history_backup_deleted_file` | backup captured a file that the edit *deletes* (so a delete is reversible too) |
| `tengu_file_history_backup_file_failed` | backup write failed |
| `tengu_file_history_track_edit_success` / `_failed` | an edit was associated with its snapshot |
| `tengu_file_history_rewind_success` / `_failed` | a rewind (restore) completed or failed |
| `tengu_file_history_rewind_restore_file_failed` | a specific file failed to restore during a rewind |
| `tengu_file_history_resume_copy_failed` | copying backups forward on a resume-with-new-session-id failed |
| `tengu_file_history_snapshots_setting_changed` | the `fileCheckpointingEnabled` setting was toggled |

There are also OTel query-source markers `query_file_history_snapshot_start` /
`query_file_history_snapshot_end` bracketing the snapshot pass.

### Storage model (verified on disk)

Backups live under the Claude config dir, **not** in the project or its `.git`:

```
~/.claude/file-history/<session-uuid>/<path-hash>@v<N>
```

Confirmed by inspection of a live install:

- `~/.claude/file-history/` contains one subdirectory **per session**, named by
  the session UUID (48 such dirs on the inspected machine).
- Inside each session dir, backup blobs are named `<path-hash>@v<N>`, where
  `<path-hash>` is a stable 16-hex-char (64-bit) hash **per distinct file path**
  and `@v1`, `@v2`, … are **successive pre-edit versions** of that same file.
  A busy session held 213 blobs spread across many path-hashes, each hash with
  1–8 versions — i.e. one blob per (file × edit).
- Each blob is a **verbatim, uncompressed copy of the file's bytes** as they were
  *before* that edit — not a diff, not a wrapped/JSON-metadata envelope. (A blob
  backing a JSON settings file was literally that JSON, byte-for-byte.) The
  exact hash algorithm producing `<path-hash>` from the absolute path is
  **unconfirmed** (a 64-bit path hash; not worth pinning down and it may change
  between builds).

So a "rewind to user message M" = for every tracked file, copy back the blob
version that was current as of M's message boundary. Restoring is a filesystem
copy from `~/.claude/file-history/…` over the working file; the working tree's
git state is never consulted or modified — hence "your git history stays clean."

### Resume semantics (why the "copy backups" errors exist)

The `FileHistory:` error strings describe how backups follow a session across a
resume:

- Resuming with the **same** session id: the backups are already under that
  session's dir — "No need to copy file history for resuming with same session
  id."
- Resuming into a **new** session id (e.g. after a fork/branch): FileHistory
  tries to copy the previous session's backups forward; failure surfaces as
  "Failed to copy backups on restore (no previous session id)" /
  "Error copying over backup from previous session" /
  `tengu_file_history_resume_copy_failed`.

The SDK's `forkSession()` documents the consequence directly: **"Forked
sessions start without undo history (file-history snapshots are not copied)."**
So a freshly forked/branched session has no code-rewind history until it
accumulates its own snapshots.

### The `sessionStore` incompatibility (storage-model tell)

A runtime guard string spells out a limitation that reveals the storage
architecture (verbatim in the current binary):

> `enableFileCheckpointing is not yet supported with sessionStore (backup blobs
> are not mirrored, so rewindFiles() fails after a store-backed resume).`

`sessionStore` is an Agent-SDK concept: a pluggable adapter that **mirrors the
session transcript** to an external store (`Options.sessionStore`, "Mirror
session transcripts to an external store"). The mirror only carries the JSONL
transcript lines — it does **not** carry the FileHistory backup blobs, which
live on the local filesystem under `~/.claude/file-history/`. Therefore, if a
session is resumed from a store-backed transcript on a machine that doesn't have
those local blobs, `rewindFiles()` has nothing to restore from and fails. This
confirms the two-tier storage model: **transcript** (mirrorable, portable) vs
**file backups** (local-only, not part of the transcript stream).

---

## The `--rewind-files` CLI flag (headless / scripted rewind)

`--rewind-files <user-message-id>` is the headless counterpart to the
interactive picker's code arm. **It is a hidden flag** — it does *not* appear in
`claude --help` output (confirmed on v2.1.197; `--help` mentions `--resume` and
`--from-pr` but never `--rewind-files`). Its internal help description is
**"Restore files to state at the specified user message and exit (requires
--resume)"**, and the SDK control-request docstring phrases it as **"Rewinds
file changes made since a specific user message."**

### Validation order (empirically reproduced, bogus IDs only)

All probes below used **synthetic/nonexistent** IDs only — never a real session
— purely to observe arg-parsing order. The flag's whole purpose is to mutate a
real session's files, so a real id is never passed.

1. **Missing argument** →
   `error: option '--rewind-files <user-message-id>' argument missing`
   (Commander-level; the flag requires a value.)
2. **`--rewind-files <id>` without `--resume`** (even if a prompt is present) →
   `Error: --rewind-files requires --resume`. The requires-`--resume` check
   fires **first**.
3. **`--rewind-files <id>` *with* `--resume <well-formed-uuid>` *and* a prompt** →
   `Error: --rewind-files is a standalone operation and cannot be used with a
   prompt`. The standalone/no-prompt check fires **after** the requires-`--resume`
   check is satisfied.
4. **`--rewind-files <well-formed-uuid>` with `--resume <well-formed-but-nonexistent-uuid>`
   and no prompt** → arg validation passes and control proceeds to session
   resolution, which fails at
   `No conversation found with session ID: <uuid>`. (A malformed resume value
   fails earlier, at
   `Error: --resume requires a valid session ID or session title when used with
   --print. Provided value "…" is not a UUID and does not match any session
   title.` — `--rewind-files` runs in `--print`/headless mode.)

So the precedence is: **argument-present → requires `--resume` → standalone (no
prompt) → resolve the resumed session → apply the file restore and exit.**
Conceptually: `--rewind-files` resumes a specific session non-interactively and
restores its tracked files to their state at the given user-message UUID, then
exits without running a turn. It is the CLI surface of the SDK's
`Query.rewindFiles(userMessageId, { dryRun? })`.

### The programmatic surface (Agent SDK)

The SDK exposes the same operation as typed methods and control requests:

- `Query.rewindFiles(userMessageId: string, options?: { dryRun?: boolean }):
  Promise<RewindFilesResult>` — "Rewind tracked files to their state at a
  specific user message. Requires file checkpointing to be enabled via the
  `enableFileCheckpointing` option." The `dryRun` option "preview[s] changes
  without modifying files."
- `RewindFilesResult = { canRewind: boolean; error?: string;
  filesChanged?: string[]; insertions?: number; deletions?: number }` — so the
  result reports whether the rewind is possible and gives a diff-stat
  (files/insertions/deletions) of what would change.
- Two separate control requests travel the SDK's stdio control channel, matching
  the picker's two arms:
  - `SDKControlRewindFilesRequest` = `{ subtype: 'rewind_files';
    user_message_id: string; dry_run?: boolean }` — "Rewinds file changes made
    since a specific user message."
  - `SDKControlRewindConversationRequest` — the conversation-truncation arm. It
    appears in the control-request union; its exact field shape was **not
    recoverable** from `sdk.d.ts` (the type is referenced but its body isn't
    emitted in the shipped `.d.ts`), so treat its payload as **unconfirmed**
    beyond "it exists as the conversation-side sibling of the file rewind."

---

## What rewind does NOT do

- **It does not track manual or bash-made edits.** Only Claude's own
  tool-driven file mutations are snapshotted by FileHistory. Durable anchor:
  **"Rewinding does not affect files edited manually or via bash."** If you (or
  a `!bash` command) edit a file outside Claude's Write/Edit tools, there is no
  pre-edit blob for it, so rewind can't restore it.
- **It is not available in cloud sessions.** Durable anchor:
  **"Rewind is not yet available in cloud sessions."** (The blobs are local
  filesystem state; a cloud-hosted session has no equivalent local backup store
  — consistent with the `sessionStore` mirror limitation above.)
- **You can only target a message still in the active context.** Selecting a
  rewind point that has aged out (e.g. summarized away by compaction) is
  rejected with **"That message is no longer in the active context. Choose a
  more recent message."** Rewind targets are bounded by the live context window,
  not the full on-disk transcript.
- **A forked session inherits no code-rewind history** (see `forkSession`
  above) — it starts with an empty FileHistory.

---

## Session/transcript bookkeeping behind rewind

Two internal message fields make rewind restorable across a resume, both visible
as `@internal` schema descriptions:

- **Permission-mode restoration.** Each user message records the permission mode
  that was active when it was sent: **"Permission mode active when this message
  was sent (for rewind restoration)."** So rewinding to a message doesn't just
  restore files/transcript — it can restore the permission mode (default /
  accept-edits / plan / auto) as it was at that point.
- **`file_snapshot` system message.** An internal `SystemMessage` of type
  `file_snapshot` carries **"Snapshot of session files (plan, todo) captured for
  rewind"** — i.e. beyond source files, rewind also checkpoints *session-managed
  files* like the plan file and the todo list, keyed to a `fileType` identifier
  (`'plan'`, `'todo'`). There is also an `autocheckpointing` attachment type in
  the transcript-normalization path, consistent with checkpoints being emitted
  automatically at user-message boundaries (the settings type describes the chat
  transcript view as showing "SendUserMessage checkpoints only").

Net: a rewind point is a user-message boundary that carries (a) the pre-edit
file blobs for that turn, (b) a snapshot of plan/todo session files, and (c) the
permission mode in force — enough to reconstruct both the files and the
interaction state, not just the chat text.

---

## Relation to sibling features (what rewind is *not*)

The tips-tour "Undo anything" card and adjacent cards draw the contrast
explicitly; brief version:

- **`/clear`** — "wipes conversation but keeps files." Forward-only reset of the
  chat; does not restore any file state. Rewind, by contrast, can move *backward*
  to a specific point and optionally restore files.
- **`/branch`** — "forks the conversation to try two approaches." Creates a new
  session diverging from a point (SDK `forkSession`, with `upToMessageId`),
  leaving the original intact. Rewind mutates the *current* session in place.
  And per `forkSession`, the branch starts with **no** file-rewind history.

So the three are distinct: `/clear` discards, `/branch` diverges into a new
session, `/rewind` restores the current session (files and/or conversation) to
an earlier point.

---

## Empirical confirm (safe, no real session touched)

Non-destructive checks that validate the findings without exercising the flag
against real data:

```sh
# 1. Confirm the flag is hidden (no rewind in --help):
claude --help 2>&1 | grep -i rewind        # → no output

# 2. Confirm validation order with bogus/synthetic IDs only:
claude --rewind-files 22222222-2222-2222-2222-222222222222 "prompt"
#   → Error: --rewind-files requires --resume
claude --resume 11111111-1111-1111-1111-111111111111 \
       --rewind-files 22222222-2222-2222-2222-222222222222 "prompt"
#   → Error: --rewind-files is a standalone operation and cannot be used with a prompt
claude --resume 22222222-2222-2222-2222-222222222222 \
       --rewind-files 33333333-3333-3333-3333-333333333333
#   → No conversation found with session ID: 22222222-2222-2222-2222-222222222222

# 3. Confirm the on-disk backup store exists and is per-session:
ls ~/.claude/file-history/                 # one dir per session UUID
ls ~/.claude/file-history/<uuid>/          # <path-hash>@vN backup blobs

# 4. Confirm the runtime guard string is in the current binary:
BIN=~/.local/share/mise/installs/node/<ver>/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe
grep -a -o 'enableFileCheckpointing is not yet supported with sessionStore[^"]*' "$BIN"
```

> **NEVER pass a real/existing session id to `--rewind-files`.** Its purpose is
> to mutate that session's files on disk and exit; a real id would restore or
> discard real work. Every probe above uses synthetic, guaranteed-nonexistent
> UUIDs purely to read the arg-parser's ordering.

## Redo-for-a-new-version checklist

1. Re-confirm the flag is still hidden: `claude --help | grep -i rewind`.
2. Re-grep the durable anchors in the cache/binary: `rewind`, `FileHistory:`,
   `tengu_file_history_`, `file_snapshot`, `fileCheckpointingEnabled`,
   `enableFileCheckpointing`. Diff the `tengu_file_history_*` event enum.
3. Re-check the SDK `sdk.d.ts` for `enableFileCheckpointing`, `rewindFiles`,
   `RewindFilesResult`, `SDKControlRewindFilesRequest`,
   `SDKControlRewindConversationRequest` — the typed surface is the strongest
   evidence and the least likely to churn.
4. Re-inspect `~/.claude/file-history/` layout (per-session dirs, `@vN` blobs).
5. Re-run the safe arg-order probes in the empirical section (bogus IDs only).
