/**
 * Port of src/resolver.go (+ src/repo_ref.go and src/template.go) from the
 * Go fnclaude implementation. Resolves a user-typed string into a concrete
 * on-disk path, cloning from GitHub if necessary.
 *
 * Design notes:
 *
 *   - All external I/O (filesystem stat, gh CLI invocation, clone) is
 *     injected via `ResolveDeps` so tests can substitute deterministic
 *     fakes. Production callers pass `productionDeps()` (which uses
 *     `node:fs/promises` and `Bun.spawn`).
 *
 *   - The resolver runs path-lookup and repo-lookup in PARALLEL and
 *     surfaces an ambiguity error when both hit. Absolute / `~`-anchored
 *     inputs short-circuit to path-only — they are unambiguously paths.
 *
 *   - repo-ref parsing and template substitution live here (not in
 *     separate modules) because they're tightly bound to Resolve's API
 *     surface and not used elsewhere yet.
 */

import { stat } from 'node:fs/promises';
import { isAbsolute, join as pathJoin, resolve as pathResolve } from 'node:path';

// ── Public types ───────────────────────────────────────────────────────────

/**
 * RepoSettings is fnclaude's view of the shared `repoSettings` block from
 * Claude Code's settings.json. Only the keys the resolver consumes are
 * modeled; the plugin-only keys (worktreeTemplate, branchTemplate,
 * gateEnvVar) are intentionally absent here.
 */
export interface RepoSettings {
  cloneTemplate?: string;
}

export interface ResolveOpts {
  /** User-typed reference. Required, non-empty. */
  input: string;
  /** User's shell cwd. Used to resolve cwd-relative paths. */
  cwd?: string;
  /** User's home directory (e.g. `os.homedir()`). */
  home: string;
  /** Merged repoSettings block from settings.json. */
  settings?: RepoSettings;
  /** Merged host-short LUT. */
  hostAliases?: Record<string, string>;
}

export interface ResolveResult {
  /** Absolute filesystem path of the resolved repo. */
  path: string;
  /** "+workspace" suffix (if any) to pass to claude via --worktree. */
  workspace?: string;
  /** True iff the resolver freshly cloned during this call. */
  justCloned?: boolean;
}

/**
 * Output of a gh CLI invocation. Only stdout is required for the resolver's
 * use cases; stderr is left for the underlying spawner to surface directly.
 */
export interface GhResult {
  stdout: string;
}

/**
 * Injectable indirections — all I/O the resolver does flows through these.
 * Tests pass stubs; production calls `productionDeps()`.
 */
export interface ResolveDeps {
  /** Return true if the path exists (file or directory). */
  pathExists: (path: string) => Promise<boolean>;
  /** Run `gh <args>` and return stdout; reject on non-zero exit. */
  ghCmd: (args: readonly string[]) => Promise<GhResult>;
  /** Shell out `gh repo clone <ownerRepo> <dest>`. */
  runClone: (ownerRepo: string, dest: string) => Promise<void>;
  /**
   * User-visible log line (e.g. "cloning X → Y"). Production writes to
   * stderr; tests stub it to silence test output and assert on the call.
   */
  log: (message: string) => void;
}

// ── Production dependency wiring ───────────────────────────────────────────

/**
 * Default deps wired to real `node:fs/promises` + `Bun.spawn` for `gh`.
 * Constructed on demand so test imports don't trigger Bun-only globals.
 */
export function productionDeps(): ResolveDeps {
  const ghCmd = async (args: readonly string[]): Promise<GhResult> => {
    const proc = Bun.spawn(['gh', ...args], { stderr: 'inherit', stdout: 'pipe' });
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) throw new Error(`gh exited ${code}: ${args.join(' ')}`);
    return { stdout };
  };
  const runClone = async (ownerRepo: string, dest: string): Promise<void> => {
    const proc = Bun.spawn(['gh', 'repo', 'clone', ownerRepo, dest], {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`gh repo clone exited ${code}`);
  };
  return {
    pathExists: async (p: string) => {
      try {
        await stat(p);
        return true;
      } catch {
        return false;
      }
    },
    ghCmd,
    runClone,
    log: (msg: string) => {
      process.stderr.write(msg.endsWith('\n') ? msg : `${msg}\n`);
    },
  };
}

// ── Repo-ref parsing (ported from src/repo_ref.go) ─────────────────────────

interface RepoRef {
  /**
   * Resolved hostname (e.g. "github.com"). Empty if absent from input;
   * callers use `effectiveHost` to default to GitHub.
   */
  host: string;
  /** Owner/org. Empty when input was a bare name. */
  owner: string;
  /** Repo name. Always present after parsing. */
  name: string;
  /** Optional "+workspace" suffix. */
  workspace?: string;
  /** Raw input for error messages. */
  original: string;
}

// URL form: https:// http:// ssh://[user@]<host>/<owner>/<name>[.git]
const URL_RE = /^(?:(?:https?|ssh):\/\/(?:[^@/]+@)?)([^:/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
// SCP form: git@host:owner/name[.git]
const SCP_RE = /^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

function parseRepoRef(input: string): RepoRef {
  if (input === '') throw new Error('empty repo reference');
  const ref: RepoRef = { host: '', owner: '', name: '', original: input };

  // Split off "+workspace" first.
  let body = input;
  const plusIdx = body.indexOf('+');
  if (plusIdx >= 0) {
    ref.workspace = body.slice(plusIdx + 1);
    body = body.slice(0, plusIdx);
    if (ref.workspace === '') {
      throw new Error(`empty workspace after \`+\` in "${input}"`);
    }
  }

  // URL forms.
  const urlM = body.match(URL_RE);
  if (urlM) {
    ref.host = urlM[1]!;
    ref.owner = urlM[2]!;
    ref.name = urlM[3]!;
    return ref;
  }
  const scpM = body.match(SCP_RE);
  if (scpM) {
    ref.host = scpM[1]!;
    ref.owner = scpM[2]!;
    ref.name = scpM[3]!;
    return ref;
  }

  // gh:owner/name shorthand.
  if (body.startsWith('gh:')) {
    const rest = body.slice(3);
    const slash = rest.indexOf('/');
    if (slash > 0 && slash < rest.length - 1) {
      const owner = rest.slice(0, slash);
      const name = rest.slice(slash + 1);
      if (/[\/@:]/.test(owner) || /[\/@:]/.test(name)) {
        throw new Error(`invalid gh: form: "${input}"`);
      }
      ref.host = 'github.com';
      ref.owner = owner;
      ref.name = name;
      return ref;
    }
    throw new Error(`gh: form requires owner/name, got "${input}"`);
  }

  // owner/name (single slash, no scheme).
  const slashIdx = body.indexOf('/');
  if (slashIdx > 0) {
    if (body.indexOf('/', slashIdx + 1) >= 0) {
      throw new Error(`ambiguous form "${input}" (multiple slashes)`);
    }
    const owner = body.slice(0, slashIdx);
    const name = body.slice(slashIdx + 1);
    if (/[@:]/.test(owner) || /[@:]/.test(name) || owner === '' || name === '') {
      throw new Error(`invalid owner/name form: "${input}"`);
    }
    ref.owner = owner;
    ref.name = name;
    return ref;
  }

  // name@owner (Tom's local-convention form).
  const atIdx = body.indexOf('@');
  if (atIdx > 0) {
    const name = body.slice(0, atIdx);
    const owner = body.slice(atIdx + 1);
    if (/[@:\/]/.test(owner) || /[@:\/]/.test(name) || owner === '' || name === '') {
      throw new Error(`invalid name@owner form: "${input}"`);
    }
    ref.name = name;
    ref.owner = owner;
    return ref;
  }

  // Bare name — defense in depth on special chars.
  if (/[\/@:]/.test(body)) {
    throw new Error(`unparseable repo reference: "${input}"`);
  }
  ref.name = body;
  return ref;
}

function effectiveHost(ref: RepoRef): string {
  return ref.host || 'github.com';
}

function hasResolvedOwner(ref: RepoRef): boolean {
  return ref.owner !== '';
}

// ── Template substitution (ported from src/template.go) ────────────────────

type TemplateVars = Record<string, () => string>;

function applyTemplate(tpl: string, vars: TemplateVars): string {
  let out = '';
  let i = 0;
  while (i < tpl.length) {
    const c = tpl[i]!;
    if (c !== '{') {
      out += c;
      i++;
      continue;
    }
    const end = tpl.indexOf('}', i + 1);
    if (end < 0) {
      // Unterminated `{` — pass through literally; user's template is
      // malformed and erroring here would be confusing.
      out += c;
      i++;
      continue;
    }
    const name = tpl.slice(i + 1, end);
    const resolver = vars[name];
    if (!resolver) {
      throw new Error(`unknown placeholder {${name}} in template "${tpl}"`);
    }
    out += resolver();
    i = end + 1;
  }
  return out;
}

function cloneTemplateVars(
  repo: string,
  owner: string,
  host: string,
  hostAliases: Record<string, string>,
): TemplateVars {
  const dotIdx = host.indexOf('.');
  const hostPlain = dotIdx >= 0 ? host.slice(0, dotIdx) : host;
  return {
    repo: () => repo,
    owner: () => owner,
    host: () => host,
    'host-plain': () => hostPlain,
    'host-short': () => {
      const alias = hostAliases[host];
      if (!alias) throw missingHostShortError(host);
      return alias;
    },
  };
}

function missingHostShortError(host: string): Error {
  return new Error(
    `cannot resolve {host-short} for host "${host}": no alias configured.\n` +
      `Add an entry to your fnclaude host-aliases LUT, e.g.:\n` +
      `  { "github.com": "gh", "gitlab.com": "gl" }`,
  );
}

// ── Tilde expansion (ported from resolver.go's expandTildePath) ────────────

function expandTildePath(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return pathJoin(home, p.slice(2));
  return p;
}

// ── Main resolver ──────────────────────────────────────────────────────────

/**
 * Resolve a user-typed reference. See module docstring for the ladder.
 *
 * `deps` defaults to production wiring; tests pass deterministic stubs.
 */
export async function Resolve(
  opts: ResolveOpts,
  deps: ResolveDeps = productionDeps(),
): Promise<ResolveResult> {
  if (!opts.input) throw new Error('empty input');

  // Absolute-path short-circuit.
  if (
    opts.input.startsWith('/') ||
    opts.input.startsWith('~/') ||
    opts.input === '~'
  ) {
    return { path: expandTildePath(opts.input, opts.home) };
  }

  // Two lookups in parallel. Each is structured: { hit, ... } so the
  // ambiguity branch can name both.
  const cwd = opts.cwd ?? process.cwd();
  const [pathLookup, repoLookup] = await Promise.all([
    resolvePathCandidate(opts.input, cwd, deps),
    resolveRepoCandidate(opts.input, deps),
  ]);

  if (pathLookup.hit && repoLookup.hit) {
    const ref = repoLookup.ref!;
    throw new Error(
      `ambiguous reference "${opts.input}":\n` +
        `  - resolves as a path: ${pathLookup.path} (exists)\n` +
        `  - resolves as a repo: ${ref.owner}/${ref.name} on ${effectiveHost(ref)}\n` +
        `disambiguate with:\n` +
        `  - an absolute or ~-anchored path for the local dir\n` +
        `  - "gh:${ref.owner}/${ref.name}" or a full URL for the repo`,
    );
  }

  if (pathLookup.hit) {
    // Local path with no repo identity — just use it. Workspace suffix
    // doesn't apply (no base repo to worktree off of).
    return { path: pathLookup.path! };
  }

  if (repoLookup.hit) {
    return cloneAndReturn(repoLookup.ref!, opts, deps);
  }

  // Neither hit.
  const hint = repoLookup.parseError ? ` (repo parse: ${repoLookup.parseError.message})` : '';
  throw new Error(
    `could not resolve "${opts.input}" as a local path (in ${cwd}) or a repo on a known host${hint}`,
  );
}

// ── Lookup branches ────────────────────────────────────────────────────────

interface PathLookup {
  hit: boolean;
  path?: string;
}

async function resolvePathCandidate(
  input: string,
  cwd: string,
  deps: ResolveDeps,
): Promise<PathLookup> {
  // cwd-relative first.
  const rel = pathJoin(cwd, input);
  if (await deps.pathExists(rel)) {
    return { hit: true, path: pathResolve(rel) };
  }
  // Then input as-is, if absolute.
  if (isAbsolute(input) && (await deps.pathExists(input))) {
    return { hit: true, path: input };
  }
  return { hit: false };
}

interface RepoLookup {
  hit: boolean;
  ref?: RepoRef;
  parseError?: Error;
}

async function resolveRepoCandidate(input: string, deps: ResolveDeps): Promise<RepoLookup> {
  let ref: RepoRef;
  try {
    ref = parseRepoRef(input);
  } catch (e) {
    return { hit: false, parseError: e as Error };
  }

  if (hasResolvedOwner(ref)) {
    if (await repoExistsOnGitHub(ref.owner, ref.name, deps)) {
      return { hit: true, ref };
    }
    return { hit: false, ref };
  }

  // Bare name — search login + orgs.
  for (const owner of await userOwnerCandidates(deps)) {
    if (await repoExistsOnGitHub(owner, ref.name, deps)) {
      ref.owner = owner;
      return { hit: true, ref };
    }
  }
  return { hit: false, ref };
}

async function userOwnerCandidates(deps: ResolveDeps): Promise<string[]> {
  const owners: string[] = [];
  try {
    const { stdout } = await deps.ghCmd(['api', 'user', '--jq', '.login']);
    const s = stdout.trim();
    if (s) owners.push(s);
  } catch {
    /* swallow — return empty if gh isn't usable. */
  }
  try {
    const { stdout } = await deps.ghCmd(['api', '/user/orgs', '--jq', '.[].login']);
    for (const line of stdout.trim().split('\n')) {
      const s = line.trim();
      if (s) owners.push(s);
    }
  } catch {
    /* swallow */
  }
  return owners;
}

async function repoExistsOnGitHub(
  owner: string,
  name: string,
  deps: ResolveDeps,
): Promise<boolean> {
  try {
    await deps.ghCmd(['api', `repos/${owner}/${name}`, '--silent']);
    return true;
  } catch {
    return false;
  }
}

// ── Clone-and-return ───────────────────────────────────────────────────────

async function cloneAndReturn(
  ref: RepoRef,
  opts: ResolveOpts,
  deps: ResolveDeps,
): Promise<ResolveResult> {
  const tpl = opts.settings?.cloneTemplate;
  if (!tpl) {
    throw new Error(
      `cannot clone ${ref.owner}/${ref.name} — no cloneTemplate configured.\n` +
        `Add to ~/.claude/settings.json:\n` +
        `  "repoSettings": { "cloneTemplate": "~/src/{repo}@{owner}" }`,
    );
  }

  const host = effectiveHost(ref);
  const vars = cloneTemplateVars(ref.name, ref.owner, host, opts.hostAliases ?? {});
  let target: string;
  try {
    target = applyTemplate(tpl, vars);
  } catch (e) {
    // Pass placeholder / host-short errors through verbatim; cloneTemplate
    // expansion errors get a wrapper for context.
    const msg = (e as Error).message;
    if (msg.includes('unknown placeholder') || msg.includes('host-short')) {
      throw e;
    }
    throw new Error(`cloneTemplate expansion: ${msg}`);
  }
  target = expandTildePath(target, opts.home);
  if (!isAbsolute(target)) {
    // cloneTemplate produced a relative path — anchor to home (we may
    // chdir before using it).
    target = pathJoin(opts.home, target);
  }

  if (await deps.pathExists(target)) {
    return {
      path: target,
      ...(ref.workspace ? { workspace: ref.workspace } : {}),
    };
  }

  // Clone. gh decides SSH vs HTTPS from its config.
  deps.log(`fnclaude: cloning ${ref.owner}/${ref.name} → ${target}`);
  try {
    await deps.runClone(`${ref.owner}/${ref.name}`, target);
  } catch (e) {
    throw new Error(`gh repo clone failed: ${(e as Error).message}`);
  }
  if (!(await deps.pathExists(target))) {
    throw new Error(`clone reported success but ${target} does not exist`);
  }
  return {
    path: target,
    justCloned: true,
    ...(ref.workspace ? { workspace: ref.workspace } : {}),
  };
}
