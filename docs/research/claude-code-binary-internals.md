# Reverse-engineering the Claude Code native binary

A runbook + findings reference for inspecting the Bun-compiled `claude` binary by grepping its embedded JavaScript. Written against **v2.1.181** (`GIT_SHA 2b2bfc5e…`, `BUILD_TIME 2026-06-17`). Offsets are version-specific; the *technique* and *string seeds* are durable.

> The core findings below were independently corroborated by direct binary greps on 2026-06-17 (the attribution builder, the entrypoint setter, the `sdk-*→claude_code_sdk` coarsening map, the entrypoint enum, the `CLAUDE_CODE_ATTRIBUTION_HEADER` kill switch, and the hardcoded salt). Minified symbol names (`nun`, `JKo`, `Xoo`, `bhp`/`_hp`, …) are build-specific and routinely differ between versions — **anchor on string literals, not names.**

## Why this exists

The renderer needs to drive `claude` over the stream-json stdio interface, which forces `-p`/headless mode. Anthropic announced (then paused, June 15 2026) a billing split that would move headless/SDK usage off the subscription pool onto a metered API-rate credit. The split keys on a client-reported "entrypoint" tag. This doc captures how that tag is produced and whether the client controls it — and, more durably, *how to answer questions like that against the native binary in general*.

## Binary facts

- **Path (mise/npm install):** `~/.local/share/mise/installs/node/<ver>/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe` (despite the `.exe` name it's the Linux ELF). The AUR/`fnclaude-bin` and other installs place it elsewhere — `which claude` then `readlink -f` to resolve.
- **Type:** ~233 MB **Bun-compiled, NOT-stripped** ELF: `file` reports `ELF 64-bit LSB executable, x86-64, …, not stripped`. The full application JS bundle is embedded as a Bun standalone snapshot and is plain-text greppable.
- **String table vs code:** literals live in a separate region from the code that references them. A `grep` for a string often lands in the *string table* (you'll see many tab-separated literals with no surrounding JS). To get the **code**, grep for a literal that only appears in source (e.g. a template-literal fragment like `cc_entrypoint=${r}`) — those don't get pooled.
- **Where versions live:** a config object literal `{ISSUES_EXPLAINER:…, PACKAGE_URL:"@anthropic-ai/claude-code", VERSION:"2.1.181", FEEDBACK_CHANNEL:…, BUILD_TIME:"…Z", GIT_SHA:"…"}` is inlined at multiple call sites. Grep `VERSION:"[0-9.]+",FEEDBACK_CHANNEL` to read version/build/sha without running the binary. (`claude --version` also prints it.)

## Technique runbook

`grep -a` treats the binary as text. Everything below assumes `BIN=<path to claude.exe>`.

**1. Enumerate a literal and its variants**
```sh
grep -aoE 'cc_entrypoint=[a-zA-Z0-9_-]*' "$BIN" | sort -u
grep -aoc 'cc_entrypoint' "$BIN"                 # count occurrences
```

**2. Pull code context inline (works when the match is in source, not the string pool)**
```sh
grep -aoE '.{120}x-anthropic-billing-header.{200}' "$BIN" | head    # window of fixed width
grep -aoE 'function JKo\(e\)\{.{0,500}' "$BIN" | head -1            # a whole short function
```
Caveat: greedy `.{N}` regexes over 233 MB are **slow and frequently return empty** when the literal contains regex metachars (`{`, `$`, `}` in template literals). When a `.{N}` grep comes back blank, switch to fixed-string offset + `dd` (step 3).

**3. Byte offset + `dd` window — the reliable path for template-literal code**

Use **fixed-string** grep (`-F`) to get a byte offset, then `dd` a window and strip NULs:
```sh
OFF=$(grep -aboF 'x-anthropic-billing-header: cc_version=' "$BIN" | head -1 | cut -d: -f1)
START=$((OFF-650))
dd if="$BIN" bs=1 skip=$START count=900 2>/dev/null | tr -d '\0' | tr '\t' ' '
```
- `grep -abo` prints `byteoffset:match`; `-F` avoids the metachar problem that bites `cc_version=${n}` (the `{n}` is interpreted by ERE).
- `tr -d '\0'` removes the embedded NUL padding Bun uses; `tr '\t' ' '` flattens the string-table tabs so output is readable.
- Tune `skip`/`count` to walk backward (find the enclosing `function X(…){`) or forward (find the `return`).
- If a `dd` window lands in the string pool (tab-separated literals, no JS), the literal you anchored on was pooled — re-anchor on a source-only fragment instead (a template literal like `cc_entrypoint=${r}` rather than the bare `x-anthropic-billing-header`).

**4. Find callers / definitions of a minified symbol**

Names are short (`nun`, `JKo`, `sPa`, `Xoo`, `kr`, `qu`). Reason *from string literals outward* — find the literal, identify the function wrapping it, then grep that function name:
```sh
grep -aoE '.{200}JKo\([^)]{0,40}\)' "$BIN" | grep -v 'function JKo' | head   # callers + the arg
grep -aoE 'function sPa\([^)]*\)\{[^}]{0,300}' "$BIN" | head -1               # definition body
grep -aoF 'function Xoo(' "$BIN"                                              # then dd from its offset
```
For const/var-assigned helpers use `grep -aoE 'NAME=[^;,]{0,120}'` (e.g. resolved `yhp="59cf53e54c78"` this way).

**5. Reproduce an algorithm to confirm**

Once you've read the construction, replay it in `node -e` to match observed output (used to confirm the 3-hex `cc_version` suffix). This validates your reading without instrumenting the binary.

**Dealing with minification:** variable names carry no meaning; the *string literals* and *control-flow shape* do. Anchor on literals, name functions by what literal they emit (`nun` = "attribution-header builder" because it produces `x-anthropic-billing-header: …`), and chase arguments by grepping the call sites.

## High-value string seeds

These literals anchored the billing investigation and are good first greps on any new version:

| Seed | Leads to |
|---|---|
| `x-anthropic-billing-header` | the attribution builder `nun(e,t)` and the system-prompt dedup pass |
| `cc_entrypoint=${r}` | source-side builder (avoids string pool); `r=process.env.CLAUDE_CODE_ENTRYPOINT??"unknown"` |
| `cc_version=` / `cch=00000` / `cc_workload=` / `cc_is_subagent=true` | each field's gate inside `nun` |
| `CLAUDE_CODE_ENTRYPOINT` | the setter `JKo(e)` and the SDK-detection predicate |
| `CLAUDE_CODE_ATTRIBUTION_HEADER` | the master disable switch (first line of `nun`) |
| `sdk-cli` | the entrypoint enum + the `sdk-*`→`claude_code_sdk` coarsening map |
| `ANTHROPIC_CUSTOM_HEADERS` | SDK client header merge (`{...l,...o.defaultHeaders}`) |
| `attribution header ` | the debug-log line emitted with the built header (see empirical cross-check) |
| `generate_session_title` | the `querySource`/`source` telemetry enum |
| `querySource:"` | full internal source enum |
| `firstParty` / `vertex` / `CLAUDE_CODE_USE_BEDROCK` | base-URL/deployment-type predicate `kr()` |
| `VERSION:"` / `GIT_SHA:` | inlined build-metadata object |

## Findings reference (v2.1.181)

### The attribution string is system-prompt text, not an HTTP header

The builder `nun(e,t)` returns a string that is pushed into the request **`system` array as a `{type:"text", text:C}` block** — there is no `headers["x-anthropic-billing-header"]=` anywhere. Three separate prompt-assembly sites split it back out via `m.startsWith("x-anthropic-billing-header")` and emit it as its own block with **`cacheScope:null`** (so the per-request-varying `cc_version` suffix doesn't invalidate the cached org/global system prompt). Implication: `ANTHROPIC_CUSTOM_HEADERS` cannot affect it, since it never becomes an HTTP header.

Builder (verbatim):
```js
function nun(e,t){
  if(gl(process.env.CLAUDE_CODE_ATTRIBUTION_HEADER)) return "";    // master kill switch
  let n = `${ {…,VERSION:"2.1.181",…}.VERSION }.${e}`;             // cc_version = 2.1.181.<suffix e>
  let r = process.env.CLAUDE_CODE_ENTRYPOINT ?? "unknown";          // cc_entrypoint — raw env, no validation
  let o = kr();                                                     // deployment type
  let s = (o==="firstParty"&&qu()) || o==="vertex" ? " cch=00000;" : "";
  let i = eun();                                                    // workload (async-store)
  let a = i ? ` cc_workload=${i};` : "";
  let l = Kwr(t) && !t.isMainSession ? " cc_is_subagent=true;" : "";
  let c = `x-anthropic-billing-header: cc_version=${n}; cc_entrypoint=${r};${s}${a}${l}`;
  return v(`attribution header ${c}`), c;                           // ← debug-logged here
}
```

Dedup/assembly (one of three near-identical sites):
```js
for(let m of e){
  if(!m) continue;
  if(m.startsWith("x-anthropic-billing-header")) c=m;     // billing block
  else if(Syn.has(m)) u=m;                                // org-cached block
  else d.push(m)
}
let p=[];
if(c) p.push({text:c, cacheScope:null});                  // billing → not cached
if(u) p.push({text:u, cacheScope:"org"});
```

### cc_entrypoint value enum + mode mapping

Set once at startup:
```js
function JKo(e){
  if(process.env.CLAUDE_CODE_ENTRYPOINT){                           // pre-set wins
    if(process.env.CLAUDE_CODE_ENTRYPOINT==="cli"&&e) process.env.CLAUDE_CODE_ENTRYPOINT="sdk-cli";
    return}
  let t=process.argv.slice(2), n=t.indexOf("mcp");
  if(n!==-1&&t[n+1]==="serve"){process.env.CLAUDE_CODE_ENTRYPOINT="mcp";return}
  if(rt(process.env.CLAUDE_CODE_ACTION)){process.env.CLAUDE_CODE_ENTRYPOINT="claude-code-github-action";return}
  process.env.CLAUDE_CODE_ENTRYPOINT = e ? "sdk-cli" : "cli";
}
// call site:
let n=t.includes("-p")||t.includes("--print"),
    r=t.includes("--init-only"),
    o=t.some(c=>c.startsWith("--sdk-url")),
    s=n||r||o||!process.stdout.isTTY;     JKo(s)
```

| Invocation | `s` | `cc_entrypoint` |
|---|---|---|
| Interactive TUI (TTY, no `-p`) | false | `cli` |
| `-p` / `--print` | true | `sdk-cli` |
| `--init-only`, `--sdk-url …`, or **any non-TTY stdout** (pipe/redirect) | true | `sdk-cli` |
| `claude mcp serve` | — | `mcp` |
| `CLAUDE_CODE_ACTION` env set | — | `claude-code-github-action` |
| `CLAUDE_CODE_ENTRYPOINT` pre-set | — | respected verbatim (only `cli`→`sdk-cli` upgrade under `-p`) |

Other literal entrypoint values in the binary: `sdk-ts`, `sdk-py`, `remote_cowork`, `claude-in-slack`, `claude-in-teams`. Coarsening map for downstream use: `sdk-cli|sdk-ts|sdk-py → claude_code_sdk`, `cli → claude_code`, teams → `claude_code_remote`.

**stream-json (`--input-format`/`--output-format stream-json`) does not by itself change the entrypoint** — the only stdin/stdout signal is `!stdout.isTTY`. Stream-json is just normally paired with `-p` + a pipe, both of which independently force `sdk-cli`. (Confirmed empirically: plain `-p` and `--input-format stream-json` both emit `cc_entrypoint=sdk-cli`.)

### cch field

Inert hardcoded placeholder. `s = (o==="firstParty"&&qu()) || o==="vertex" ? " cch=00000;" : ""`. No hash, no key, no per-request input. Emitted for normal first-party (`api.anthropic.com`) and Vertex traffic; omitted when `ANTHROPIC_BASE_URL` points off first-party. Gates:
```js
function kr(){return rt(env.CLAUDE_CODE_USE_BEDROCK)?"bedrock":…:rt(env.CLAUDE_CODE_USE_VERTEX)?"vertex":"firstParty"}
function qu(){if(env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL)return!0; return uln()}
function uln(){let e=env.ANTHROPIC_BASE_URL; if(!e)return!0; return C7e(e)}
```

### cc_version varying 3-hex suffix

`cc_version = 2.1.181.<suffix>` where suffix = first arg `e` to `nun`, computed as:
```js
var yhp="59cf53e54c78";                          // hardcoded 12-hex constant in the build
function Xoo(e,t){
  let r=[4,7,20].map(i=>e[i]||"0").join("");      // chars at indices 4,7,20 of e
  let o=`${yhp}${r}${t}`;
  return oPa.createHash("sha256").update(o).digest("hex").slice(0,3);   // first 3 hex
}
// (the "first non-meta user message text" finder; minified name varies — bhp/_hp across builds)
function _hp(e){let t=e.find(r=>r.type==="user"&&!r.isMeta); … return <that message's text>}
function sPa(e){let t=_hp(e); return Xoo(t, {…VERSION:"2.1.181"…}.VERSION)}   // 2nd arg → "2.1.181"
// W=sPa(D);  cc_version=2.1.181.${W}
```
So **suffix = `SHA256("59cf53e54c78" + chars[4,7,20] of the first non-meta user message + "2.1.181").slice(0,3)`**. Deterministic; input is only 3 sampled characters of the first user message. It *appears* to vary per request because each agentic turn's first user message differs. **Not a security control:** public in-binary salt, 12-bit output, and it does **not** include `cc_entrypoint` in the hashed input — so it can't bind the billing attribution. It's at most a recomputable consistency tag.

### source= / querySource enum

Internal telemetry, distinct from billing. Interactive main thread = `repl_main_thread`; headless/SDK main = `sdk`. Full enum includes: `repl_sampling, compact, extract_memories, generate_session_title, agent_namer, agent_classifier, agent_creation, agent_summary, auto_mode, auto_mode_critique, auto_dream, away_summary, feedback, insights, side_question, speculation, web_search_tool, web_fetch_apply, hook_prompt, hook_agent, permission_explainer, prompt_suggestion, tool_use_summary_generation, model_validation, session_search, teleport_generate_title, mcp_datetime_parse, rename_generate_name`, plus `agent:custom`/`agent:*`. Feeds OTel `query_source` attribute and per-source model sampling; not the subscription-vs-metered key.

Note: a single CLI invocation emits **two** billed `/v1/messages` requests — `source=generate_session_title` and `source=sdk` — both carrying the same `cc_entrypoint`.

### Header-override precedence

- `CLAUDE_CODE_ENTRYPOINT` — pre-setting it wins (`JKo` early-returns); value is interpolated raw, no allowlist → **fully spoofable** (with the one guard that an explicit `cli` is upgraded to `sdk-cli` under `-p`).
- `CLAUDE_CODE_ATTRIBUTION_HEADER` — set ⇒ `nun` returns `""`, suppressing the whole attribution block.
- `ANTHROPIC_CUSTOM_HEADERS` — irrelevant to billing (it's prompt text). Even for real HTTP headers the merge is `o.defaultHeaders={...userHeaders,...o.defaultHeaders}` → **app headers spread last, app wins** on key collision.

### Endpoint / auth

Single messages endpoint `/v1/messages` (+`?beta=`); no separate headless host (`api.anthropic.com/api/...` paths are OAuth/feedback/domain-info, not messages). Auth is one OAuth-vs-APIkey branch (`anthropicAuthEnabled && oauthScopes…` vs `apiKey`). The attribution block has **no auth-type guard** — only the `CLAUDE_CODE_ATTRIBUTION_HEADER` disable — so it's sent on **both** OAuth (subscription) and API-key requests.

### Spoofability bottom line

`cc_entrypoint` is purely advisory and trivially client-controlled today: raw env var interpolated verbatim into a system-prompt text block, no signature / allowlist / server-verifiable binding. The `cch` slot that looks like an integrity check is inert `00000`; the `cc_version` SHA suffix — the most integrity-shaped element — uses a public in-binary salt over 3 sampled chars and doesn't cover `cc_entrypoint`, so it protects neither the entrypoint nor the billing attribution. **Proven:** read path, no validation, env override, disable switch, prompt-text-not-HTTP-header, the suffix algorithm. **Not proven (inferred):** that the server doesn't independently re-derive entrypoint from other request features (OAuth token type, request shape). Given the dormant `cch` slot is clearly reserved for a real signature, treat the current weakness as something Anthropic can close server-side at any time — do not build durable economics on spoofing it.

## Empirical cross-check (no binary needed)

The builder logs the header it produces via `v(\`attribution header ${c}\`)`. Capture it live:
```sh
claude -d api --debug-file /tmp/cc.log -p "hi"
grep -a 'attribution header' /tmp/cc.log
# → attribution header x-anthropic-billing-header: cc_version=2.1.181.<hex>; cc_entrypoint=sdk-cli; cch=00000;
```
Vary the invocation to confirm the mapping: drop `-p` and run interactively (entrypoint → `cli`), pipe stdin (non-TTY → `sdk-cli`), or pre-set `CLAUDE_CODE_ENTRYPOINT=cli`/`CLAUDE_CODE_ATTRIBUTION_HEADER=1` to watch the value change or the line vanish. This is the fastest way to validate findings against a running build.

## Redo-for-a-new-version checklist

1. `file "$BIN"` → confirm `not stripped` ELF; note size. Read `VERSION:"…",…GIT_SHA:` to record the version/sha.
2. `grep -aoE 'cc_entrypoint=[a-zA-Z0-9_-]*' "$BIN" | sort -u` and `grep -aoE 'querySource:"[a-z_0-9]+"' "$BIN" | sort -u` — diff the enums vs this doc.
3. `OFF=$(grep -aboF 'x-anthropic-billing-header: cc_version=' "$BIN" | head -1 | cut -d: -f1)`; `dd … skip=$((OFF-650)) count=900 | tr -d '\0'` — re-read the builder; confirm `cc_entrypoint` still `??"unknown"` from env and the `cch`/suffix logic.
4. Grep `function JKo(e)` (or whatever now sets `CLAUDE_CODE_ENTRYPOINT`) — confirm the `-p`/TTY/`--sdk-url` detection and the value mapping.
5. Re-resolve the suffix: grep `function Xoo(`, read the indices/salt; replay in `node -e` to confirm.
6. Check `CLAUDE_CODE_ATTRIBUTION_HEADER` and the `ANTHROPIC_CUSTOM_HEADERS` merge order still hold.
7. **Empirical confirm:** `claude -d api --debug-file /tmp/cc.log -p "hi"; grep -a 'attribution header' /tmp/cc.log`. If the debug line or the builder shape changed, update this doc.

> Note: all byte offsets here are v2.1.181-specific and **will not match** other builds — always re-derive offsets with `grep -aboF`; only the string seeds and method carry over.
