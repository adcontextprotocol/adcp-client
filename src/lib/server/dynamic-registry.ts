/**
 * Hot-reloadable multi-registry plumbing.
 *
 * `createDynamicRegistry` packages the multi-registry-atomicity idiom
 * every adopter that hot-reloads tenants from a database independently
 * rebuilds. The shim in scope3data/agentic-adapters built this three
 * times (v5 PlatformAdapter, v6 DecisioningPlatform, v6
 * OperationalPlatform) before the pattern crystallized — each
 * iteration with its own hard-won bug fixes.
 *
 * Lessons baked in:
 *
 * 1. **Single-pointer atomic swap.** The bundle of all registry Maps
 *    is held behind one `let bundle` reference. A refresh builds the
 *    new bundle to completion in a side struct and reassigns the
 *    pointer in one statement. A concurrent reader (per-request
 *    lookup) crossing an `await` mid-refresh sees the OLD bundle
 *    until swap, the NEW bundle after — never a mix where one
 *    registry has the new data and another doesn't.
 *
 * 2. **In-flight refresh guard.** Concurrent calls to `refresh()`
 *    coalesce onto the same Promise. Sequential calls get fresh
 *    work. Without this, two parallel refreshes race on
 *    `store.list()` snapshots and last-writer-wins regardless of
 *    which snapshot is fresher.
 *
 * 3. **Pinned-carry-forward.** Entries registered with
 *    `{ pinned: true }` survive refresh without rebuild. Adopters
 *    pin their built-in tenants once at startup and let `refresh()`
 *    rebuild only the dynamic ones from config. Pin always wins
 *    over `pending` writes — refresh callbacks cannot accidentally
 *    overwrite a pinned id.
 *
 * 4. **Lock-step unregister.** `unregister(id)` removes from every
 *    named registry in one operation. No "removed from adapters but
 *    still in operational" half-state.
 *
 * 5. **Per-registry typed `get`.** Caller declares per-registry value
 *    types via the generic; `get('adapters', id)` returns the right
 *    type without casts.
 *
 * @example
 * ```ts
 * import { createDynamicRegistry } from '@adcp/sdk/server';
 *
 * interface MyRegistries {
 *   adapters: PlatformIdentity;
 *   v6: AnyDecisioningPlatform;
 *   operational: OperationalPlatform;
 * }
 *
 * const registry = createDynamicRegistry<MyRegistries>({
 *   refresh: async pending => {
 *     const configs = await store.list();
 *     for (const config of configs) {
 *       pending.adapters.set(config.platformId, buildAdapter(config));
 *       pending.v6.set(config.platformId, buildPlatform(config));
 *       pending.operational.set(config.platformId, deriveOperational(config));
 *     }
 *   },
 * });
 *
 * // Static — survives refresh
 * registry.register('adapters', 'snap', snapAdapter, { pinned: true });
 * registry.register('v6', 'snap', snapPlatform, { pinned: true });
 *
 * // Hot-reload (overlapping calls coalesce automatically)
 * await registry.refresh();
 *
 * // Per-request lookups
 * registry.get('adapters', platformId);
 * registry.get('operational', platformId);
 * ```
 *
 * Status: 6.10. See adcontextprotocol/adcp-client#1531.
 *
 * @public
 */

/**
 * Type-level mapping from registry name to its value type. Adopters
 * provide this as the type parameter to `createDynamicRegistry` so
 * `register`, `get`, and the `pending` argument to the refresh
 * callback are all typed per registry without casts.
 */
export type RegistryShape = Record<string, unknown>;

/**
 * The `pending` argument passed to a refresh callback. One Map per
 * registry; values are typed per `TRegistries[K]`.
 */
export type PendingRegistries<TRegistries extends RegistryShape> = {
  [K in keyof TRegistries]: Map<string, TRegistries[K]>;
};

export interface DynamicRegistryRegisterOptions {
  /**
   * Mark this entry as static. Survives every refresh. Pin always
   * wins: a refresh callback that writes the same id into `pending`
   * is silently overridden by the pinned value at swap time.
   *
   * Use for built-in tenants registered at startup. Dynamic tenants
   * loaded from config should NOT be pinned — they live in `pending`
   * and rebuild on every refresh.
   *
   * **Pinned values are immutable until `unregister`.** Refresh-source
   * updates do not propagate to pinned entries. Adopters who rotate
   * credentials for a pinned tenant must explicitly call
   * `unregister(id)` and `register()` again with the new value — a
   * `refresh()` cycle alone will not pick up the rotation. If you want
   * refresh-driven updates, do not pin.
   */
  pinned?: boolean;

  /**
   * Permit overwriting an existing entry with the same name + id.
   * Default `false` — duplicate registration throws so silent
   * tenant clobbering doesn't ship to production.
   */
  overwrite?: boolean;
}

export interface DynamicRegistryConfig<TRegistries extends RegistryShape> {
  /**
   * Refresh callback. Invoked when `refresh()` is called. The
   * `pending` argument is a fresh empty bundle of Maps (one per
   * registry); the callback writes the new dynamic entries into
   * each. On callback resolve, the framework atomically swaps the
   * live bundle to `pending` ∪ pinned-carry-forward.
   *
   * Concurrent calls to `refresh()` coalesce onto a single
   * invocation of this callback. Sequential calls get fresh
   * invocations.
   *
   * Optional. Adopters with no dynamic tenants (only pinned static
   * registrations) skip this and never call `refresh()`.
   */
  refresh?: (pending: PendingRegistries<TRegistries>) => Promise<void>;
}

export interface DynamicRegistry<TRegistries extends RegistryShape> {
  /**
   * The registry names declared by `TRegistries`. Useful for
   * diagnostics and iteration.
   */
  readonly registryNames: ReadonlyArray<keyof TRegistries & string>;

  /**
   * Register an entry under one named registry. Throws on duplicate
   * (same registry + same id) unless `{ overwrite: true }` is set.
   * Pinned entries survive every subsequent `refresh()`.
   */
  register<K extends keyof TRegistries & string>(
    name: K,
    id: string,
    value: TRegistries[K],
    options?: DynamicRegistryRegisterOptions
  ): void;

  /**
   * Remove `id` from every registered registry in lock-step. No-op
   * for ids that aren't present. Pinned entries are removed too —
   * `unregister` is the only way to drop a pin without restarting
   * the process.
   */
  unregister(id: string): void;

  /**
   * Look up an entry by registry name + id. Returns `undefined` for
   * unknown ids or unknown registry names (the latter is also a TS
   * type error — `K` is constrained to known names).
   */
  get<K extends keyof TRegistries & string>(name: K, id: string): TRegistries[K] | undefined;

  /**
   * List the ids currently registered under `name`. Includes both
   * pinned and dynamic entries. Useful for diagnostics; not on the
   * hot path.
   */
  ids<K extends keyof TRegistries & string>(name: K): string[];

  /**
   * Trigger the refresh callback. Rebuilds the dynamic portion of
   * the bundle from scratch; pinned entries carry forward. Concurrent
   * calls coalesce onto the same Promise.
   *
   * Returns a rejected Promise if no `refresh` callback was supplied
   * at construction (does not throw synchronously — callers can `await`
   * uniformly).
   */
  refresh(): Promise<void>;
}

interface InternalBundle<TRegistries extends RegistryShape> {
  maps: { [K in keyof TRegistries]: Map<string, TRegistries[K]> };
  pinned: { [K in keyof TRegistries]: Set<string> };
}

/**
 * Build a hot-reloadable multi-registry. Names of the registries and
 * their value types come from the `TRegistries` type parameter.
 *
 * @example
 * ```ts
 * interface MyRegistries {
 *   adapters: PlatformIdentity;
 *   v6: AnyDecisioningPlatform;
 *   operational: OperationalPlatform;
 * }
 *
 * const registry = createDynamicRegistry<MyRegistries>({
 *   refresh: async pending => { ... },
 * });
 * ```
 *
 * The runtime call needs to know which registry names exist, so the
 * caller passes them either implicitly (via the first `register()`
 * call) or — recommended — eagerly by registering each at construction
 * with no entries. To make the registry-name set declarative, prefer
 * the explicit-names overload below.
 */
export function createDynamicRegistry<TRegistries extends RegistryShape>(
  config: DynamicRegistryConfig<TRegistries> & {
    /**
     * The list of registry names. Required so the framework can
     * pre-allocate Maps and validate `register`/`get` calls before
     * any entry is added.
     */
    registries: ReadonlyArray<keyof TRegistries & string>;
  }
): DynamicRegistry<TRegistries> {
  const names = [...config.registries];

  // Validate construction: empty registries are useless; duplicate names
  // would shadow each other in the bundle Maps and produce confusing
  // "unknown registry" errors at lookup time. Surface both at
  // construction with specific messages.
  if (names.length === 0) {
    throw new Error('createDynamicRegistry: `registries` must contain at least one name.');
  }
  const dedupedNames = new Set(names);
  if (dedupedNames.size !== names.length) {
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    throw new Error(
      `createDynamicRegistry: duplicate registry name(s): ${dupes.map(n => JSON.stringify(n)).join(', ')}.`
    );
  }

  function emptyBundle(): InternalBundle<TRegistries> {
    const maps = {} as InternalBundle<TRegistries>['maps'];
    const pinned = {} as InternalBundle<TRegistries>['pinned'];
    for (const name of names) {
      maps[name as keyof TRegistries] = new Map();
      pinned[name as keyof TRegistries] = new Set();
    }
    return { maps, pinned };
  }

  // Single-pointer atomic-swap target. All reads and writes go through
  // this reference. Refresh builds a new InternalBundle to completion
  // and reassigns the reference in one statement — atomic across
  // `await` for any concurrent reader.
  let bundle: InternalBundle<TRegistries> = emptyBundle();

  // In-flight refresh guard. Concurrent calls observe the same Promise
  // until it settles, then the next call gets a fresh one.
  let inflight: Promise<void> | null = null;

  function assertKnownRegistry(name: string): void {
    if (!dedupedNames.has(name)) {
      throw new Error(
        `createDynamicRegistry: unknown registry name ${JSON.stringify(name)}. ` +
          `Known names: ${names.map(n => JSON.stringify(n)).join(', ')}.`
      );
    }
  }

  return {
    registryNames: Object.freeze([...names]) as ReadonlyArray<keyof TRegistries & string>,

    register(name, id, value, options) {
      assertKnownRegistry(name);
      const map = bundle.maps[name];
      const allowOverwrite = options?.overwrite === true;
      if (map.has(id) && !allowOverwrite) {
        throw new Error(
          `createDynamicRegistry: duplicate registration for ${JSON.stringify(name)}/${JSON.stringify(id)}. ` +
            `Pass { overwrite: true } if the duplicate is intentional.`
        );
      }
      // Non-pinned register during in-flight refresh writes to the
      // LIVE bundle. The live bundle becomes `liveBundle` in the
      // refresh closure; at swap, the new bundle is built from
      // `pending` ∪ `liveBundle.pinned` — so a non-pinned mid-refresh
      // register is silently dropped at swap time. This is documented
      // semantics; callers who race `register` against `refresh`
      // either pin the entry (so it survives the swap) or serialize
      // the operations.
      map.set(id, value);
      if (options?.pinned === true) {
        bundle.pinned[name].add(id);
      }
    },

    unregister(id) {
      for (const name of names) {
        bundle.maps[name].delete(id);
        bundle.pinned[name].delete(id);
      }
    },

    get(name, id) {
      assertKnownRegistry(name);
      return bundle.maps[name].get(id);
    },

    ids(name) {
      assertKnownRegistry(name);
      return [...bundle.maps[name].keys()];
    },

    // CRITICAL: do not mark `async`. The non-async signature is
    // load-bearing for the coalesce contract — `async refresh()` would
    // wrap the returned Promise, so two parallel callers each get a
    // NEW wrapper around the shared `inflight`, not `inflight` itself.
    // Adopters who `Promise.all([a, b])` rely on reference equality
    // so a single completion settles all waiters at once. Pinned by
    // the test "concurrent refresh() calls coalesce".
    refresh(): Promise<void> {
      if (!config.refresh) {
        return Promise.reject(
          new Error('createDynamicRegistry: refresh() called but no `refresh` callback was supplied at construction.')
        );
      }
      if (inflight) return inflight;

      const callback = config.refresh;
      inflight = (async () => {
        try {
          // Capture the live pinned snapshot BEFORE building pending.
          // Adopters who call `register({ pinned: true })` between the
          // refresh-start and the callback's first await point still
          // get carry-forward — the snapshot is the as-of-await-zero
          // bundle, plus any in-flight pin registrations.
          const liveBundle = bundle;

          // pending = fresh empty Maps. Callback fills them.
          const pending = {} as PendingRegistries<TRegistries>;
          for (const name of names) {
            pending[name as keyof TRegistries] = new Map() as PendingRegistries<TRegistries>[keyof TRegistries];
          }

          await callback(pending);

          // Build new bundle: pending values first, then pinned values
          // from the live bundle. Pin always wins — a callback that
          // wrote a pinned id into `pending` is silently overridden.
          const next = emptyBundle();
          for (const name of names) {
            const nextMap = next.maps[name];
            for (const [k, v] of pending[name]) nextMap.set(k, v);
            for (const pinnedId of liveBundle.pinned[name]) {
              const pinnedValue = liveBundle.maps[name].get(pinnedId);
              if (pinnedValue !== undefined) {
                nextMap.set(pinnedId, pinnedValue);
                next.pinned[name].add(pinnedId);
              }
            }
          }

          // Single-pointer reassignment. Atomic across `await` —
          // a concurrent reader sees liveBundle until this line and
          // `next` after.
          bundle = next;
        } finally {
          inflight = null;
        }
      })();

      return inflight;
    },
  };
}
