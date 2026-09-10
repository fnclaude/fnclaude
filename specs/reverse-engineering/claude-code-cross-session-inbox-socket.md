# Cross-session messaging — the local inbox socket

How Claude Code delivers a message from one local session to another: the
per-session Unix-domain **inbox socket**, its address, the authentication that
gates it, the on-the-wire message shape, and the documented path by which a
non-Claude script posts into a session.

This is the transport under `SendMessage`/`ListAgents` for same-machine peers.
The sibling doc [`claude-code-teammate-modes.md`](claude-code-teammate-modes.md)
covers *where* teammates execute and the `SendMessage` settings; this doc is the
socket mechanics. Cross-**machine** peers travel a different path (the Remote
Control bridge / cloud) — see the `bridge:` / `did:` schemes below and
[`claude-remote-control.md`](claude-remote-control.md).

Written against the **v2.1.263** binary (2026-09) plus the official
cross-session-messaging docs, and confirmed with a live probe on the same
version. Anchored on env-var names, log prefixes, and schema/scheme strings —
all public contract; no minified symbol names. **Provenance caveat:** the
`SendMessage` feature shipped in **v2.1.224**; the March-2026 source-map leak
(**v2.1.88**) predates it, so every leak-derived source mirror stubs the UDS
transport files (`udsMessaging.ts`, `udsClient.ts` are `export {}`). The
findings here come from the current binary's strings, the official docs, and
empirical observation — not from leaked source.

---

## The headline: it is local, and UID-gated

Same-machine delivery is a **Unix-domain socket on macOS/Linux** (a named pipe
on native Windows), and the official docs state it travels "over a per-session
socket on your machine, **never through Anthropic servers**." Only cross-machine
and cloud peers pass through Anthropic servers.

The connecting process's identity is read from the kernel, from the socket, not
from the payload. The binary's own schema description for the verified-sender
field:

> Kernel-verified pid of the process that connected to this session's
> cross-session messaging socket, read from the connection
> (SO_PEERCRED / LOCAL_PEERPID) — never from the payload. This identifies the
> CONNECTING process, which for relayed traffic (e.g. a daemon forwarding on
> another session's behalf) is the relay, not the message's author.

`SO_PEERCRED` only exists for local sockets, so this is structurally incapable
of running remotely. On a shared machine, another OS user cannot deliver: the
socket is restricted to the owning user.

---

## Address schemes

A recipient address parses into one of three schemes (the parser keeps the
scheme and the remainder after the prefix):

| Prefix | Scheme | Transport |
|---|---|---|
| `uds:` | local | this doc — the inbox Unix socket |
| `bridge:` | Remote Control | another of your machines, via Anthropic servers |
| `did:` | cloud | a Claude Code on the web session |
| bare `/…` path | local (legacy) | routed as `uds:` so old bare-path senders still reply |

`isolatePeerMachines` gates only the non-local schemes; same-machine (`uds:`)
sends never prompt for it.

---

## The socket: path, directory, liveness

Each session with messaging enabled **binds one inbox socket**. Its address is
exported and shown in two places:

- The env var **`CLAUDE_CODE_MESSAGING_SOCKET`** — exported to hooks and Bash
  commands before any hook runs (including `SessionStart`). Each session exports
  its own, never a parent's.
- `/status` shows it in the `Peer address` row, prefixed `uds:`.

**Directory resolution** (first that is acceptable):

1. `/run/user/<uid>/cc-socks` — the XDG runtime dir form (observed live).
2. `/tmp/cc-socks-<uid>` — the per-user private fallback. The `-<uid>` suffix
   is what makes it private; the docs call it `/tmp/cc-socks-<uid>`.
   (macOS: `/private/tmp/cc-socks…`; Termux has its own prefix.)

Claude Code refuses a directory it cannot accept — one another user owns, or
world-writable without the sticky bit — and falls back to the private per-user
dir. If none is acceptable the session runs with **no inbox** (`/status` →
`Peer address: unavailable`).

**Filename:** `<pid>.sock`, where `<pid>` is the session's process id. The
socket is mode `0600` (`srw-------`).

**Liveness gating.** Discovery does not blindly connect to every socket in the
directory; a candidate is vetted on `<pid>` being a live process whose start
time matches (`expectPeerPid` / `expectPeerProcStart`, guarding against pid
reuse). A socket whose named pid is dead, or is not the process that created it,
is skipped. (Empirically, a socket owned by a non-`claude` process was also not
listed by a discovering session — the vet is stricter than "some live pid.")

Server-side log lines carry the `[uds-messaging]` prefix; the count/telemetry
side is `[concurrentSessions]`. The feature is flag-gated behind `UDS_INBOX`.

---

## Authentication

| Platform | Gate |
|---|---|
| **Linux / macOS / WSL 2** | socket restricted to the OS user (UID). The auth line is **optional**. |
| **native Windows** | named pipe; a valid auth line is **required** — the connection is closed otherwise. |

Alongside the socket path, Claude Code exports a per-session token as
**`CLAUDE_CODE_MESSAGING_TOKEN`**. A script may send, as the first line of its
connection:

```json
{"type":"auth","token":"<CLAUDE_CODE_MESSAGING_TOKEN>"}
```

On Linux/macOS this line is accepted-or-omitted; on Windows it is mandatory.
The Windows named pipe is where the `<pid>.<64-hex>.key` files would matter —
on Linux none exist, matching a live directory that holds only `.sock` files.

### Own-child verification

When no `crossSessionInbound` value applies, a message the session verifies came
from **its own child processes** (a hook or Bash command posting back to its own
socket) is *delivered*, bypassing the hold that a peer message would get:

- **Linux/WSL 2:** verified by process evidence, **even after the poster has
  exited**.
- **macOS after the poster exits, or a container where Claude Code is PID 1:**
  no process evidence — verified instead by the token in the auth line.
- **native Windows:** the token is the only own-child proof.
- When neither can verify, the message is treated as asserting no permission
  class (so a `bypassPermissions` session holds it for approval).

---

## Wire protocol

**Newline-delimited JSON**, one object per line. (Note: the Bun runtime's own
length-prefixed `SocketFramer` — a 4-byte big-endian length then the body — is
present in the binary for Bun's inspector protocol and is *not* the script-post
framing. A raw length-prefixed frame sent to the inbox is silently ignored.)

- Open the connection only when the message is ready: a connection that has not
  sent a complete line within **30 seconds** is closed.
- Optional first line (Linux/macOS): the `{"type":"auth","token":…}` line above.
- Then the message line. The message object carries these wire fields
  (behavioural description; these are the durable field names, not minified
  symbols):

  | Field | Meaning |
  |---|---|
  | `msgV` | message-format version (currently `1`) |
  | `msg_id` | a UUID |
  | `type` | `"user"` for a user-turn delivery |
  | `message` | `{ role: "user", content }` — `content` is a string or content-block array |
  | `priority` | `"next"` to enqueue ahead |
  | `from` | sender name (integrity is keyed on `SO_PEERCRED`, not on this) |
  | `file_attachments` | optional |

The connector also presents a small identity/hello (peer-protocol version,
feature list, `kind`, `entrypoint`, `name`, `nameSource`, and its own
`messagingSocketPath` as a reply address). The advertised feature list includes
`notify_when_idle`, `artifact_yield`, and conditionally
`reply_across_default_dirs`.

**`from` is display-only, not identity.** The receiver keys the sender on the
`SO_PEERCRED` pid of the connecting process, never on the payload's `from`. A
connector whose pid is not a registered session (see
`~/.claude/sessions/<pid>.json`) is shown as **`unidentified session
[verified pid <N>]`**, regardless of what `from` claims. To be rendered as a
**named** sender, the posting process must itself be a registered session.

**Permission-mode attestation.** A real session's handshake attests its
permission mode. A peer that does *not* attest is **held** by a receiver that
bypasses permission prompts (`bypassPermissions`), surfaced as
`Held peer message — from an unidentified session … The sender did not attest
its permission mode and this session bypasses prompts`, and delivered only on
approval or with `crossSessionInbound: accept`. The `SendMessage` tool attaches
this attestation; a bare socket post does not.

---

## Delivery semantics

Once a connection is authorized, the arriving message runs the receiver's
**inbound controls** (`crossSessionInbound`): `accept` (deliver), `hold` (set
aside for approval), or `refuse` (drop). With no explicit value, the outcome is
decided by the two sessions' permission-mode classes — a `bypassPermissions`
receiver **holds** a peer message unless the sender also identifies as bypassing;
a prompting receiver delivers it. The own-child exception above is what lets a
hook/Bash child deliver into a bypass session without a hold.

- A delivered message is read **between tool calls** during an active turn (a
  running tool is never interrupted); when the session is **idle**, Claude Code
  **starts a new turn** with it.
- `-p` (headless) sessions bind an inbox too, but cannot show an approval
  dialog: a held message waits out `dialogExpiry` (default 5 min) then is
  dropped. This is why a message posted to a `bypassPermissions -p` target with
  default settings appears to vanish — it was *held then expired*, not rejected.
- `notify_when_idle` (a `SendMessage` input) subscribes to a one-shot notice
  when the target next goes idle or exits; 12-hour expiry.
- Rate limits: identical repeats in a short window are dropped, at most 50
  accepted messages queue, and the same-machine size cap is ~1,000,000 chars
  (refused at the sender).

---

### Two orthogonal axes: delivery and identity

Whether a socket-posted message is *delivered* and whether it shows a *name* are
**independent**, decided by two separate checks on the connecting pid
(`SO_PEERCRED`). Conflating them causes misdiagnosis; keeping them apart explains
every observed case.

| Axis | Question | Passes when the connecting pid… | Forgeable by a process? |
|---|---|---|---|
| **Delivery** (delivered vs held) | own-child or peer? | is a **live descendant of the *receiving* session** at connect time | Yes — but only into a session you descend from |
| **Identity** (named vs `unidentified`) | is the sender a known session? | **is itself a registered session's own pid** | No — not via a spoofed record, a hello frame, or ancestry |

Consequences, each confirmed empirically:

- A process that **reparents** (backgrounded, `setsid`, orphaned to init/systemd)
  loses the delivery axis for its own session — it is no longer a live
  descendant, so its post is *held* even into the session that spawned it.
- A process that is a live descendant of session A but posts to session B is a
  **peer** to B (delivery fails → held), regardless of ancestry to A.
- Ancestry to *some* claude session does **not** grant identity: a non-detached
  descendant of a real session, posting to a different session, still renders
  `unidentified [verified pid N]`. Identity requires the pid to *be* a session.
- The two are independent: an **own-child** post (delivered) still renders as the
  block form, because the poster (a hook, a script, an MCP subprocess) is not
  itself a registered session.

The practical corollary for a launcher: a persistent child of a session — the
fnclaude MCP subprocess is the natural one, a direct child kept alive for the
session's life, already holding `CLAUDE_CODE_MESSAGING_SOCKET` and
`CLAUDE_CODE_MESSAGING_TOKEN` — can post **own-child** messages into its session
that are **delivered with no hold**, rendered as the block form (never named).
That is the only supported, no-hold, local write-surface into a running session.

### How a delivered message renders

The receiver renders in two distinct forms, keyed on whether the message carries
a trusted, registered sender name:

- **Named peer (the `SendMessage` tool path):** a compact, collapsible one-liner,
  `› Message from @<name>: <first line>` (dim, `ctrl+o` to expand). Used when the
  sender resolves to a registered session name.
- **Socket post (bare poster, own-child or peer):** a full highlighted block,
  `Another Claude session sent a message: <body>`, followed by the standard
  cross-session guard paragraph. Used whenever there is no trusted sender
  identity — which is always the case for a raw socket post, since `from` is
  ignored and the posting pid is not a registered session. Confirmed for both an
  own-child post into one's own session (delivered, still the block form) and a
  peer post to another session (held, then the block form on approval).

**The named form cannot be forged from outside.** A bare poster was made to
mimic a session — its own `~/.claude/sessions/<pid>.json` written with a `name`
and a matching `procStart`, its own `<pid>.sock` inbox bound, and permission-mode
fields added to the message — and it still rendered as `unidentified session
[verified pid <N>]`, held. So the on-disk record does **not** drive sender
identity; the receiver verifies the *live* connecting process is a genuine
session by means a non-Claude process cannot satisfy.

Ancestry does not help either: a **child of a genuine registered session**
(a Bash/script descendant of a real `claude`) posting to a *different* session
also rendered as `unidentified session [verified pid <N>]`, held. The receiver
does not walk the connecting pid up to an owning session — the named identity is
bound to the **actual session process that calls `connect()`**, i.e. the pid
`SO_PEERCRED` reports must itself be the registered session's pid.

Nor does presenting the identity in the payload help: a process that wrote its
own session record, bound its inbox socket, **and sent an explicit
`{"type":"hello", …}` identity frame with `permissionMode` before the message**
was still rendered `unidentified session [verified pid <N>]`, held, "did not
attest its permission mode." The receiver reads neither the sender's identity
nor its permission-mode attestation from the connection payload — both are
established by the genuine runtime through a channel a plain process cannot
join (a live registry of real sessions, and/or a `/proc`/credential check on
the connecting pid — not the on-disk `sessions/<pid>.json` file, which a
non-session process can write but which does not confer identity).

The compact `Message from @name` form is therefore effectively reserved for
genuine Claude-to-Claude `SendMessage`, where the sending session's own process
connects; a script/launcher post always lands as the block form, and — to a
`bypassPermissions` receiver — held unless `crossSessionInbound: accept`. The one
silent path a non-session process has is an **own-child** post into the very
session it descends from: delivered with no hold (no yellow notice), still the
block form.

## Posting into a session from a script (the supported path)

The docs explicitly bless "a script or hook to post into a session." Minimal
Linux client — connect, optional auth line, one message line:

```python
import socket, os, json, uuid

sock = os.environ["CLAUDE_CODE_MESSAGING_SOCKET"]
token = os.environ.get("CLAUDE_CODE_MESSAGING_TOKEN", "")

s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(sock)
send = lambda o: s.sendall((json.dumps(o) + "\n").encode())

send({"type": "auth", "token": token})          # optional on Linux/macOS
send({
    "msgV": 1,
    "msg_id": str(uuid.uuid4()),
    "type": "user",
    "message": {"role": "user", "content": "…text one Claude writes for another…"},
    "priority": "next",
    "from": "my-poster",
})
s.close()
```

**Confirmed empirically (2026-09-09):** a bare `python3` process run as a child
of a live session, posting to that session's `CLAUDE_CODE_MESSAGING_SOCKET`,
delivered a message that arrived in the session as an ordinary inbound
teammate message — indistinguishable from a real peer send.

### Addressing a *different* session

The address is computable without any registry when you know the target's pid:

```
<runtime-dir>/cc-socks/<target-pid>.sock
```

where `<runtime-dir>` is `/run/user/<uid>` (else `/tmp/cc-socks-<uid>`). To
reach a session by **name** instead, read the on-disk session registry each
session writes: **`~/.claude/sessions/<pid>.json`**, holding at least
`{ name, sessionId, pid, cwd }`. Mapping a name to a socket is therefore: scan
`~/.claude/sessions/*.json` for the `name`, take its `pid`, and build
`<runtime-dir>/cc-socks/<pid>.sock`. A caller that already holds the pid (a
launcher that spawned the session) skips the lookup entirely. Delivery (vs.
hold) then depends on the own-child relationship, the token, and the target's
permission mode as above.

---

## What this affords a launcher (fnc)

A process that *spawns* the session holds the pid and shares the UID, so it can
construct the inbox address directly — no discovery. A hook or Bash child it
launches posts via the exported `CLAUDE_CODE_MESSAGING_SOCKET` and is verified
as own-child (delivered even under `bypassPermissions`). This is a **documented,
supported local write-surface into a running session** — unlike keystroke
injection (a fragile TUI hack) or channels (gated behind an Anthropic-curated
allowlist with no third-party path).

**Stability caveat:** only `CLAUDE_CODE_MESSAGING_SOCKET` /
`CLAUDE_CODE_MESSAGING_TOKEN` and the auth-line shape are documented contract.
The address *construction* (`<runtime-dir>/cc-socks/<pid>.sock`) and the message
envelope fields are observed from the current version and may shift; addressing
one's *own* session via the env var is the durable part.

---

## Reusable string seeds

| Seed | Leads to |
|---|---|
| `CLAUDE_CODE_MESSAGING_SOCKET` / `CLAUDE_CODE_MESSAGING_TOKEN` | the exported inbox address + per-session token |
| `cc-socks` | the socket directory; the path-resolution regex set |
| `~/.claude/sessions/<pid>.json` | the name→session registry (`{name, sessionId, pid, cwd}`) |
| `[uds-messaging]` | server-side connect/error log lines |
| `[concurrentSessions]` | the peer-count/telemetry side |
| `UDS_INBOX` | the feature flag gating the whole subsystem |
| `expectPeerPid` / `expectPeerProcStart` | the pid + start-time liveness vet |
| `SO_PEERCRED` / `LOCAL_PEERPID` | kernel-verified connecting-process identity |
| `getDefaultUdsSocketPath` | default socket-path construction |
| `notify_when_idle` / `artifact_yield` / `reply_across_default_dirs` | advertised peer features |
| `crossSessionInbound` / `isolatePeerMachines` | inbound controls + cross-machine gate |
| `uds:` / `bridge:` / `did:` | the three recipient address schemes |
