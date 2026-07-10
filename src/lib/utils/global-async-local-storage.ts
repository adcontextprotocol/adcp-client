import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Returns a process-global {@link AsyncLocalStorage} identified by `key`.
 *
 * The package ships both an ESM and a CommonJS build. If a single process
 * loads both (some dependencies `import` @adcp/sdk while others `require` it),
 * each build would otherwise construct its own `AsyncLocalStorage`. A
 * `.run(...)` established on one copy is then invisible to a `.getStore()` on
 * the other, so request-signing and response-capture context would silently
 * disappear — requests could go out unsigned with no error. Anchoring the
 * instance on the global symbol registry guarantees a single shared store no
 * matter how many copies of this module exist.
 */
export function globalAsyncLocalStorage<T>(key: string): AsyncLocalStorage<T> {
  const registryKey = Symbol.for(`@adcp/sdk.als.${key}`);
  const registry = globalThis as unknown as Record<symbol, AsyncLocalStorage<T> | undefined>;
  const existing = registry[registryKey];
  if (existing) return existing;
  const created = new AsyncLocalStorage<T>();
  registry[registryKey] = created;
  return created;
}
