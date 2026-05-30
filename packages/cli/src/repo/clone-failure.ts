/**
 * Pure classifier for `gh repo clone` failure stderr.
 *
 * We only ever call this on the failure path (a non-zero gh exit) and use
 * it to decide whether the failure was "the repo doesn't exist" — in which
 * case fnclaude offers to bootstrap a fresh local repo — versus any other
 * failure (auth, network, gh missing), which still hard-fails as before.
 *
 * Matching is signature-based on GitHub's not-found messages. Auth and
 * network errors must NOT be classified as not-found.
 */

const NOT_FOUND_SIGNATURES = [
  // GraphQL clone path (gh repo clone uses the API):
  //   "GraphQL: Could not resolve to a Repository with the name 'x/y'."
  /could not resolve to a repository/i,
  // git/HTTPS path: "remote: Repository not found" / "Repository not found"
  /repository not found/i,
];

export function isRepoNotFoundError(stderr: string): boolean {
  return NOT_FOUND_SIGNATURES.some((re) => re.test(stderr));
}
