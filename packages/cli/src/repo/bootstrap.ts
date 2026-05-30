/**
 * Bootstrap orchestrator for the "repo doesn't exist yet" path.
 *
 * Reached only when a `gh repo clone` failed *because the target repo
 * doesn't exist on the host* (classified by clone-failure.ts). Rather than
 * hard-failing, we offer to create a fresh LOCAL repo at the destination,
 * then optionally create the (private) GitHub remote — both behind
 * default-No prompts so a non-interactive run declines and hard-fails as
 * before.
 *
 * Flow:
 *   1. confirm "bootstrap as new local repo?" (default No)
 *        declined → { kind: 'declined' }
 *   2. mkdirp(destination) → gitInit(destination, url)   (LOCAL only)
 *   3. confirm "create the GitHub repository now? (private)" (default No)
 *        accepted → ghRepoCreate(owner, name); on failure, WARN but still
 *                   launch in the local dir (don't lose the local work)
 *   4. → { kind: 'launched', cwd: destination }
 *
 * All side effects are injected via `deps` so the orchestration is
 * unit-testable with fakes. Real runners live in gh-runner.ts / git-runner.ts
 * and are wired in main.ts.
 */

export interface BootstrapDeps {
  confirm: (question: string, def: boolean) => Promise<boolean>;
  mkdirp: (path: string) => Promise<void>;
  gitInit: (dir: string, url: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  ghRepoCreate: (owner: string, name: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  log: (msg: string) => void;
}

export interface BootstrapRepoArgs {
  owner: string;
  name: string;
  host: string;
  destination: string;
  url: string;
  deps: BootstrapDeps;
}

export type BootstrapResult =
  | { kind: 'launched'; cwd: string }
  | { kind: 'declined' }
  | { kind: 'error'; error: string };

export async function bootstrapRepo(args: BootstrapRepoArgs): Promise<BootstrapResult> {
  const { owner, name, host, destination, url, deps } = args;

  const wantsBootstrap = await deps.confirm(
    `Repository ${owner}/${name} doesn't exist on ${host}. Bootstrap it as a new local repo at ${destination}? [y/N] `,
    false,
  );
  if (!wantsBootstrap) return { kind: 'declined' };

  try {
    await deps.mkdirp(destination);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'error', error: `failed to create directory ${destination}: ${msg}` };
  }

  const initR = await deps.gitInit(destination, url);
  if (!initR.ok) {
    return { kind: 'error', error: `git init failed: ${initR.error}` };
  }
  deps.log(`fnclaude: initialized empty repo at ${destination} (origin → ${url})`);

  const wantsRemote = await deps.confirm(
    `Create the GitHub repository ${owner}/${name} now? It will be created private. [y/N] `,
    false,
  );
  if (wantsRemote) {
    const createR = await deps.ghRepoCreate(owner, name);
    if (createR.ok) {
      deps.log(`fnclaude: created private GitHub repository ${owner}/${name}`);
    } else {
      deps.log(
        `fnclaude: warning — gh repo create ${owner}/${name} failed: ${createR.error}. Launching in the local repo anyway.`,
      );
    }
  }

  return { kind: 'launched', cwd: destination };
}
