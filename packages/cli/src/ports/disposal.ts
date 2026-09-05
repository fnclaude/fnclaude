/**
 * Adapt a service's `stop()` to the `Symbol.dispose` / `Symbol.asyncDispose`
 * protocol, so the container's LIFO teardown stops it on `using` / `await using`
 * (design.di-architecture §2b). `standardLifetime` captures for teardown only
 * instances offering the Symbol protocol; fnclaude's leaves expose `.stop()`, so
 * the factory wraps the leaf here instead of the leaf changing.
 */

/** Wrap a leaf whose `stop()` is asynchronous as an {@link AsyncDisposable}. */
export function asAsyncDisposable<T extends { stop(): Promise<void> | void }>(
  service: T,
): T & AsyncDisposable {
  return Object.assign(service, {
    async [Symbol.asyncDispose](): Promise<void> {
      await service.stop();
    },
  });
}

/** Wrap a leaf whose `stop()` is synchronous as a {@link Disposable}. */
export function asDisposable<T extends { stop(): void }>(service: T): T & Disposable {
  return Object.assign(service, {
    [Symbol.dispose](): void {
      service.stop();
    },
  });
}
