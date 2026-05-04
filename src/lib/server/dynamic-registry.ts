/**
 * `createDynamicRegistry` — atomic hot-reload helper for adopters that manage
 * multiple correlated Maps of platform objects (adapters, v6 platforms,
 * operational platforms, etc.) refreshed together from a config store.
 *
 * ## The problem this solves
 *
 * Any adopter that hot-reloads tenants from a database maintains multiple
 * parallel Maps that must be swapped together — a reader must never see
 * `adapters` at version N+1 while `v6Platforms` is still at N. Three
 * atomicity pitfalls appear in every hand-rolled implementation:
 *
 *   1. `clear() + for-set` looks atomic but is not across `await`.
 *   2. Three separate pointer reassignments are not atomic across `await`.
 *   3. Concurrent `refresh()` calls without an in-flight guard race
 *      (last-writer-wins regardless of which snapshot is fresher).
 *
 * This factory bakes in the correct idioms: single-pointer bundle swap,
 * in-flight coalescing guard (with `finally`-based release so a thrown
 * refresh never freezes the registry), and static-id carry-forward with a
 * denylist that respects explicit `unregister()` calls.
 *
 * ## Usage
 *
 * ```ts
 * import { createDynamicRegistry } from '@adcp/sdk/server';
 * import type { PlatformIdentity, DecisioningPlatform } from '@adcp/sdk/server';
 *
 * const registry = createDynamicRegistry<{
 *   adapters: PlatformIdentity;
 *   v6: DecisioningPlatform;
 * }>({
 *   registries: ['adapters', 'v6'],
 *   staticIds: () => Array.from(hardcodedPlatformIds),   // optional
 *   refresh: async (pending) => {
 *     const configs = await store.list();
 *     for (const config of configs) {
 *       pending.adapters.set(config.platformId, buildAdapter(config));
 *       pending.v6.set(config.platformId, buildPlatform(config));
 *     }
 *   },
 * });
 *
 * // Per-request lookups — typed per registry name:
 * const adapter = registry.get('adapters', platformId); // PlatformIdentity | undefined
 * const v6      = registry.get('v6', platformId);       // DecisioningPlatform | undefined
 *
 * // Hot-reload — overlapping calls coalesce onto the same Promise:
 * await registry.refresh();
 * ```
 *
 * ## Before the first `refresh()`
 *
 * All Maps are empty; `get()` returns `undefined` for every id. Callers
 * that dispatch requests before the first refresh completes must handle
 * `undefined` (or await the first `refresh()` during startup).
 *
 * ## Error behavior
 *
 * When `refresh()` throws, the previous bundle is preserved — the registry
 * continues serving the last known-good state. The error is re-thrown to all
 * callers that were coalesced onto that refresh Promise. The in-flight guard
 * is cleared in `finally` so subsequent `refresh()` calls start fresh rather
 * than remaining permanently frozen.
 *
 * ## `staticIds` carry-forward
 *
 * `staticIds()` is called on **each** `refresh()` so the adopter can update
 * the static set at runtime. For each id returned by `staticIds()`, if
 * `refresh` did not populate that id's entry in a named Map, the factory
 * carries the previous bundle's entry forward. If an id has been explicitly
 * `unregister()`-ed, it is suppressed from carry-forward even if
 * `staticIds()` still returns it.
 *
 * ## `unregister(id)`
 *
 * Removes `id` from every named Map in the current bundle atomically
 * (single-turn deletion, synchronous). Returns `true` if `id` was present
 * in at least one Map. Also adds `id` to an internal denylist so future
 * `refresh()` cycles do not carry it forward via `staticIds`. The denylist
 * is permanent for the registry's lifetime — there is no "re-register a
 * formerly unregistered id" path; if you need that, `refresh()` to a fresh
 * bundle that includes the id.
 *
 * **Memory note.** The denylist grows by one entry per `unregister()` call
 * and is never pruned. In long-lived processes with high tenant churn,
 * recreate the registry periodically or manage the static-id list instead
 * of relying on `unregister()` for large-scale eviction.
 *
 * @public
 */

/**
 * Type-map from registry name to the value type stored in that registry's
 * Map. Provide as the type parameter to `createDynamicRegistry`:
 *
 * ```ts
 * createDynamicRegistry<{
 *   adapters: PlatformIdentity;
 *   v6: DecisioningPlatform;
 * }>({ ... })
 * ```
 *
 * @public
 */
export type RegistryTypeMap = Record<string, unknown>;

/** @public */
export interface DynamicRegistryOptions<TRegistries extends RegistryTypeMap> {
  /**
   * Names of the registries to manage. Must be a subset of `keyof TRegistries`.
   * Each name gets its own `Map<string, TRegistries[name]>` in every bundle.
   */
  registries: ReadonlyArray<keyof TRegistries & string>;

  /**
   * Optional thunk returning ids that should be preserved across `refresh()`
   * cycles. Called on every `refresh()` so you can update the set at runtime.
   * Ids that `refresh()` already populated are unaffected; the carry-forward
   * only applies to ids missing from the new pending Maps. Ids in the
   * `unregister()` denylist are suppressed even if `staticIds()` returns them.
   */
  staticIds?: () => string[];

  /**
   * Populate the `pending` Maps for the next bundle. Called on every
   * non-coalesced `refresh()`. The `pending` Maps are pre-allocated, fresh,
   * and empty — do not hold references to them after `refresh` resolves;
   * they become the live bundle and later modifications would race with
   * concurrent readers.
   *
   * The callback's return value is ignored. Use closures to pass metadata
   * (e.g. record count) to outer scope if needed.
   */
  refresh: (pending: { [K in keyof TRegistries]: Map<string, TRegistries[K]> }) => Promise<unknown>;
}

/** @public */
export interface DynamicRegistry<TRegistries extends RegistryTypeMap> {
  /**
   * Look up an id in the named registry. Returns the value or `undefined` if
   * the id is not in the current bundle. Type-safe per registry name.
   */
  get<K extends keyof TRegistries>(name: K, id: string): TRegistries[K] | undefined;

  /**
   * Trigger a hot-reload. Builds a fresh set of Maps by calling
   * `opts.refresh(pending)`, carries forward any `staticIds` not populated by
   * the callback, then atomically swaps the bundle with a single pointer
   * assignment. Concurrent calls are coalesced — all callers share the same
   * in-flight Promise. Sequential calls each get a fresh refresh.
   *
   * On throw: the previous bundle survives unchanged; the in-flight guard is
   * cleared so subsequent calls succeed.
   */
  refresh(): Promise<void>;

  /**
   * Remove `id` from every named registry in the current bundle. Returns
   * `true` if `id` was present in at least one registry. Also adds `id` to
   * the denylist, suppressing it from `staticIds()` carry-forward on all
   * future refreshes.
   */
  unregister(id: string): boolean;
}

/**
 * Build a {@link DynamicRegistry} that manages multiple correlated Maps with
 * atomic bundle-swap and in-flight refresh coalescing.
 *
 * @public
 */
export function createDynamicRegistry<TRegistries extends RegistryTypeMap>(
  opts: DynamicRegistryOptions<TRegistries>
): DynamicRegistry<TRegistries> {
  type Bundle = { [K in keyof TRegistries]: Map<string, TRegistries[K]> };

  const names = opts.registries;

  function makeBundle(): Bundle {
    const b = {} as Bundle;
    for (const name of names) {
      b[name] = new Map<string, TRegistries[typeof name]>();
    }
    return b;
  }

  // Live bundle — all reads go through this single pointer.
  // Atomic because JavaScript is single-threaded: `bundle = pending`
  // executes in one synchronous step between microtasks; concurrent
  // readers are never mid-assignment.
  let bundle: Bundle = makeBundle();

  // In-flight guard — concurrent refresh() calls return the same Promise.
  // Cleared in `finally` so a thrown refresh never permanently freezes
  // the registry.
  let inflight: Promise<void> | null = null;

  // Ids explicitly removed via unregister() are suppressed from staticIds()
  // carry-forward on all future refreshes.
  const denylist = new Set<string>();

  return {
    get<K extends keyof TRegistries>(name: K, id: string): TRegistries[K] | undefined {
      return bundle[name].get(id);
    },

    refresh(): Promise<void> {
      if (inflight !== null) {
        return inflight;
      }

      const pending = makeBundle();

      const p: Promise<void> = (async () => {
        await opts.refresh(pending);

        // Carry forward static ids that refresh() didn't populate,
        // unless they're in the unregister() denylist.
        const staticIds = opts.staticIds?.() ?? [];
        for (const id of staticIds) {
          if (denylist.has(id)) continue;
          for (const name of names) {
            if (!pending[name].has(id)) {
              const prev = bundle[name].get(id);
              if (prev !== undefined) {
                pending[name].set(id, prev);
              }
            }
          }
        }

        // Atomic swap — single statement, executes synchronously between
        // microtasks. All subsequent reads see the new bundle in full;
        // no reader can observe a half-rebuilt mix.
        bundle = pending;
      })().finally(() => {
        if (inflight === p) {
          inflight = null;
        }
      });

      inflight = p;
      return p;
    },

    unregister(id: string): boolean {
      let removed = false;
      for (const name of names) {
        if (bundle[name].delete(id)) {
          removed = true;
        }
      }
      // Suppress from staticIds() carry-forward on all future refreshes.
      denylist.add(id);
      return removed;
    },
  };
}
