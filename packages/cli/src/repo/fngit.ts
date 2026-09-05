/**
 * The fngit seam — how fnc turns a repo reference into a directory.
 *
 * fnc used to own this whole problem: parsing `name@owner` / `gh:owner/name` /
 * URL forms, expanding a clone template, searching source directories,
 * resolving a bare name's owner through `gh`, cloning, and bootstrapping a
 * missing repo. All of it now lives in `@rhombus.rocks/fngit`, which fnc talks
 * to **as a CLI on PATH** (specs/rhombus-rocks-config.md § "fngit CLI
 * contract") — never as a library, so fnc has no build-time dependency on it
 * and a user can upgrade one without the other.
 *
 * The contract fnc relies on is deliberately tiny:
 *
 *   `fngit clone <ref> [git-clone-flags]`
 *     resolves the ref (bare name, `name@owner`, `owner/name`, `gh:owner/name`,
 *     HTTPS or SSH URL), finds an existing clone or clones it, and prints
 *     **the absolute path on stdout and nothing else**. Progress goes to
 *     stderr. Non-zero exit means failure, with the reason on stderr.
 *     Already-cloned prints the path and touches no network.
 *
 * fnc must not parse stderr — it relays it. That is what keeps fngit free to
 * reword its diagnostics.
 *
 * fngit is OPTIONAL. Without it on PATH, fnc accepts only real paths, and any
 * repo reference gets an error naming `fnc install`. Every call here goes
 * through an injected {@link FngitRunner}, so tests drive the seam without a
 * binary: the npm build available while this was written (1.3.0) predates the
 * contract above, so testing through the seam is the only honest option.
 */

export interface FngitResult {
  ok: boolean;
  /** stdout, trimmed. On a successful `clone` this is the absolute path. */
  stdout: string;
  /** stderr, trimmed. Relayed verbatim on failure; never parsed. */
  stderr: string;
  exitCode: number;
}

/** Runs `fngit <args>` and captures its output. */
export type FngitRunner = (args: readonly string[]) => Promise<FngitResult>;

/** Locates the `fngit` binary on PATH. Returns null when it isn't installed. */
export type FngitLocator = () => string | null;

/**
 * The real locator: `Bun.which` against the inherited PATH. Separate from
 * {@link makeFngitRunner} so a caller can ask "is fngit available?" without
 * being ready to run it — the answer changes the error message fnc prints.
 */
export const findFngit: FngitLocator = () => Bun.which('fngit');

/** Build a runner that shells out to the given fngit binary. */
export function makeFngitRunner(bin: string): FngitRunner {
  return async (args) => {
    const proc = Bun.spawn([bin, ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      // Piped, not inherited: `clone` writes progress to stderr, and fnc
      // relays it only on failure. Inheriting would interleave fngit's
      // progress with fnc's own diagnostics at unpredictable points.
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      ok: exitCode === 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode,
    };
  };
}

/**
 * The error fnc prints when a repo reference arrives with no fngit installed.
 * Names `fnc install` because that is the wizard that installs it — the whole
 * point of the closing sentence is that the user has something to run next.
 */
export function missingFngitError(ref: string): string {
  return (
    `cannot resolve ${JSON.stringify(ref)}: fngit is not installed, so fnc only accepts ` +
    'paths to repositories you have already cloned (absolute, `~/`-anchored, or `./`-relative). ' +
    'Run `fnc install` to set up fngit, which resolves repo names and clones them for you.'
  );
}

export type LocateResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

export interface LocateRepoArgs {
  /** The reference as the user typed it, with any `+workspace` already stripped. */
  ref: string;
  /** Injected runner. Absent means fngit is not installed. */
  fngit: FngitRunner | null;
  /** Progress sink for the "resolving…" line. Defaults to no output. */
  onProgress?: (line: string) => void;
}

/**
 * Resolve a repo reference to an absolute path by way of `fngit clone`.
 *
 * `clone` is the right verb even for a repo that already exists locally: the
 * contract makes it the single "give me the path to this repo, fetching it if
 * you must" entry point, and an already-cloned repo resolves without touching
 * the network. That collapses fnc's old needs-clone / needs-owner-lookup /
 * ambiguous-local fork into one call.
 */
export async function locateRepo(args: LocateRepoArgs): Promise<LocateResult> {
  const { ref, fngit } = args;
  if (fngit === null) {
    return { ok: false, error: missingFngitError(ref) };
  }

  args.onProgress?.(`fnclaude: resolving ${ref} via fngit`);

  let result: FngitResult;
  try {
    result = await fngit(['clone', ref]);
  } catch (err) {
    return {
      ok: false,
      error: `failed to run fngit: ${(err as Error).message}`,
    };
  }

  if (!result.ok) {
    // Relay fngit's own reason. fnc must not parse or reinterpret it — the
    // contract reserves the wording to fngit. An empty stderr still gets a
    // message, because "exit 3" alone tells the user nothing.
    const reason = result.stderr !== '' ? result.stderr : `fngit exited ${result.exitCode}`;
    return { ok: false, error: `could not resolve ${JSON.stringify(ref)}: ${reason}` };
  }

  // stdout is contractually "the absolute path and nothing else". Take the
  // last non-empty line rather than the whole capture: an fngit that leaks a
  // stray line to stdout would otherwise hand fnc a multi-line "path" and the
  // launch would fail somewhere far less obvious.
  const lines = result.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const path = lines[lines.length - 1];
  if (path === undefined) {
    return {
      ok: false,
      error: `fngit resolved ${JSON.stringify(ref)} but printed no path`,
    };
  }
  return { ok: true, path };
}
