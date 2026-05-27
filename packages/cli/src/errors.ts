// Error-handling helpers shared across the CLI.
//
// `errorMessage` collapses the "throw value can be anything" branch into a
// single safe path: real Errors yield their `.message`, anything else gets
// stringified. Used at every catch-and-format site that previously did
// `(err as Error).message` — a cast that silently produces `undefined` (and
// then crashes the error-handling path itself) whenever the thrown value
// isn't actually an Error instance.

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
