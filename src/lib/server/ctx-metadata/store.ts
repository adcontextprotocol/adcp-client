/**
 * Ctx-metadata store for AdCP server handlers.
 *
 * Publishers attach platform-specific opaque blobs to any returned
 * resource (product, media_buy, package, creative, audience, signal,
 * rights_grant). The framework persists the blob keyed by
 * `(account_id, kind, id)`, strips it from buyer-facing wire payloads,
 * and threads it back into the publisher's request context on
 * subsequent calls referencing the same resource ID.
 *
 * Use case: GAM ad_unit_ids per product, GAM order_id per media_buy,
 * line_item_id per package — adapter-internal state the AdCP wire
 * spec doesn't model. Avoids forcing publishers to re-derive on every
 * call or maintain a side-cache the SDK could provide.
 *
 * Scope is `(account_id, kind, id)` — keys are tenant-isolated. No
 * auto-eviction by design (a media buy lifetime can be months).
 * Adopter-driven cleanup via `cleanupExpiredCtxMetadata(db)` for
 * Postgres deployments that opt into row-level `expires_at`.
 *
 * @example
 * ```ts
 * import { createCtxMetadataStore, memoryCtxMetadataStore } from '@adcp/sdk/server';
 *
 * const store = createCtxMetadataStore({ backend: memoryCtxMetadataStore() });
 *
 * createAdcpServerFromPlatform({ platform, ctxMetadata: store });
 * ```
 *
 * @public
 */

/**
 * Resource kinds the ctx-metadata store recognizes. Closed enum:
 * adding a new kind is a coordinated change across the framework
 * dispatch (which kinds get hydrated on which request shapes).
 */
export type ResourceKind =
  | 'account'
  | 'product'
  | 'media_buy'
  | 'package'
  | 'creative'
  | 'audience'
  | 'signal'
  | 'rights_grant'
  | 'property_list'
  | 'collection_list'
  | 'si_session';

const ALL_RESOURCE_KINDS: readonly ResourceKind[] = [
  'account',
  'product',
  'media_buy',
  'package',
  'creative',
  'audience',
  'signal',
  'rights_grant',
  'property_list',
  'collection_list',
  'si_session',
];

/**
 * Default size cap on serialized blob, in bytes. Crossed → `CTX_METADATA_TOO_LARGE`.
 *
 * Memory backend without a cap is a single-node DoS vector; Postgres
 * JSONB performance dies at scale before disk does. 16KB covers the
 * common case (ad_unit_ids arrays, key-value targeting maps) with
 * room to spare.
 */
export const DEFAULT_MAX_VALUE_BYTES = 16 * 1024;

/**
 * Maximum allowed TTL in seconds. Crossed → throws at `set()`.
 *
 * Lifetime of a media buy can be months, but unbounded retention
 * compounds drift between SDK cache and publisher truth. 30 days is
 * the soft ceiling; cleanup is adopter-driven beyond that.
 */
export const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Account ID and resource ID shape allowlist. Excludes the U+001F
 * separator used in the flattened storage key, NUL bytes that
 * Postgres TEXT rejects, and anything else that could confuse the
 * key parser.
 */
const VALID_KEY_SEGMENT = /^[A-Za-z0-9_.:\-]{1,255}$/;

/**
 * Symbol tag attached to retrieved blobs. Symbols don't survive
 * `JSON.stringify`, so an accidental serialization in error envelopes
 * / log lines / agent-card payloads silently elides the blob.
 * Defense-in-depth against LLM-context leaks.
 */
export const ADCP_INTERNAL_TAG = Symbol.for('adcp.ctx_metadata.internal');

export interface CtxMetadataEntry {
  /** Opaque publisher-attached value. Untouched by the framework. */
  value: unknown;
  /**
   * SDK-attached AdCP wire resource shape (e.g., the full `Product` /
   * `MediaBuy` / `Creative` object minus `ctx_metadata`). Populated by
   * the framework's auto-hydration path, not by adopter code.
   *
   * Used to reconstruct a hydrated resource on subsequent calls that
   * reference the same id by string. Buyer sends `product_id: 'p1'`;
   * SDK looks up the entry, builds `{ ...resource, ctx_metadata: value }`,
   * attaches as `req.packages[i].product`.
   *
   * Adopter code never reads or writes this field — the framework owns
   * it end-to-end.
   */
  resource?: unknown;
  /** Optional unix epoch seconds expiry. Informational; no auto-eviction. */
  expiresAt?: number;
}

/**
 * Storage backend interface. Swap implementations for memory / Postgres / Redis.
 *
 * Keys are flattened to `${accountId}${kind}${id}` before
 * reaching the backend. Validation runs before flattening — backends
 * trust their inputs.
 */
export interface CtxMetadataBackend {
  get(scopedKey: string): Promise<CtxMetadataEntry | null>;
  bulkGet(scopedKeys: readonly string[]): Promise<Map<string, CtxMetadataEntry>>;
  put(scopedKey: string, entry: CtxMetadataEntry): Promise<void>;
  delete(scopedKey: string): Promise<void>;
  /** Optional startup probe. Implementations wrapping an external store should implement. */
  probe?(): Promise<void>;
  /** Optional resource-release hook. Called by `store.close()`. */
  close?(): Promise<void>;
  /** Optional test-harness flush. Used by `compliance.reset()` between storyboards. */
  clearAll?(): Promise<void>;
}

export interface CtxMetadataStoreConfig {
  /** Storage backend. Use `memoryCtxMetadataStore()` for dev, `pgCtxMetadataStore(pool)` for cluster. */
  backend: CtxMetadataBackend;
  /**
   * Max serialized blob size in bytes. Defaults to 16384 (16KB).
   * Crossed → `CTX_METADATA_TOO_LARGE` thrown at `set()`.
   */
  maxValueBytes?: number;
}

/**
 * Reference to a stored entry. `bulkGet` accepts an array of these;
 * the resulting Map is keyed by `${kind}:${id}` for caller convenience.
 */
export interface CtxMetadataRef {
  kind: ResourceKind;
  id: string;
}

export interface CtxMetadataStore {
  /**
   * Look up a single entry. Returns `undefined` (not `null`) for misses
   * so publishers can branch with `??` against their own DB.
   *
   * Returned values carry a non-enumerable `[ADCP_INTERNAL_TAG]: true`
   * marker — JSON serialization elides it automatically (defense
   * against accidental leak via error envelopes and log lines).
   */
  get(accountId: string, kind: ResourceKind, id: string): Promise<unknown | undefined>;

  /**
   * Bulk lookup. Returns a Map keyed by `${kind}:${id}` so callers
   * with mixed-kind refs (e.g., `create_media_buy` carrying products
   * + an audience ref) can index without remembering what they asked for.
   * Misses are absent from the Map (no `undefined` entries).
   */
  bulkGet(accountId: string, refs: readonly CtxMetadataRef[]): Promise<ReadonlyMap<string, unknown>>;

  /**
   * Store a blob. Throws `CTX_METADATA_TOO_LARGE` if `JSON.stringify(value).length`
   * exceeds the configured cap. Throws `INVALID_ARGUMENT` for null/undefined/empty
   * `accountId` or out-of-shape `id`.
   *
   * `ttlSeconds` is optional and capped at 30 days. No auto-eviction.
   */
  set(accountId: string, kind: ResourceKind, id: string, value: unknown, ttlSeconds?: number): Promise<void>;

  /**
   * Framework-only: persist the wire resource alongside the publisher's
   * `ctx_metadata` blob. Called by the dispatch seam after a publisher
   * returns a resource (Product, MediaBuy, etc.) so subsequent calls
   * referencing that id by string can hydrate the full object.
   *
   * Adopter code does NOT call this — wire resource caching is the
   * framework's job. Public-but-internal: lives on the interface so
   * the dispatch layer doesn't need a privileged store handle.
   *
   * @internal — adopter code should use `set()`. The framework calls this.
   */
  setEntry(accountId: string, kind: ResourceKind, id: string, entry: CtxMetadataEntry): Promise<void>;

  /**
   * Framework-only: update the wire resource for an existing or new
   * entry while preserving the publisher's `value` (ctx_metadata blob).
   * Called by the auto-store path so a publisher's prior
   * `ctx.ctxMetadata.set('product', id, blob)` is NOT overwritten when
   * the publisher returns the product without `ctx_metadata` on the
   * wire shape.
   *
   * Update semantics:
   *   - If entry exists: merge — keep prior `value`, set new `resource`,
   *     keep prior `expiresAt`.
   *   - If entry doesn't exist: create with `value: priorValue ?? null`,
   *     `resource: resource`.
   *   - If `priorValue` is provided AND the publisher returned ctx_metadata
   *     on the resource (non-null priorValue param), the new value wins.
   *
   * @internal
   */
  setResource(
    accountId: string,
    kind: ResourceKind,
    id: string,
    resource: unknown,
    publisherCtxMetadata?: unknown
  ): Promise<void>;

  /**
   * Framework-only: lookup the full entry (value + resource) by id.
   * Used by the auto-hydration path to reconstruct hydrated resources.
   * Adopter code uses `get()` for the value alone.
   *
   * @internal
   */
  getEntry(accountId: string, kind: ResourceKind, id: string): Promise<CtxMetadataEntry | undefined>;

  /**
   * Framework-only: bulk variant of `getEntry`.
   * @internal
   */
  bulkGetEntries(accountId: string, refs: readonly CtxMetadataRef[]): Promise<ReadonlyMap<string, CtxMetadataEntry>>;

  /** Delete a single entry. Tenant-scoped via `accountId`. */
  delete(accountId: string, kind: ResourceKind, id: string): Promise<void>;

  /** Probe the backend for boot-time readiness. */
  probe(): Promise<void>;

  /** Release backend resources (close pools, clear timers). */
  close(): Promise<void>;

  /** Test-harness reset. Throws if backend doesn't support it (no `force` opt — production safety). */
  clearAll(): Promise<void>;
}

/**
 * Validation error thrown for bad input shape. Distinct from
 * `CTX_METADATA_TOO_LARGE` (size violation) so callers can branch.
 */
export class CtxMetadataValidationError extends Error {
  constructor(
    public readonly code: 'INVALID_ARGUMENT' | 'CTX_METADATA_TOO_LARGE',
    message: string
  ) {
    super(message);
    this.name = 'CtxMetadataValidationError';
  }
}

/**
 * Compose the flattened storage key. Internal — backends trust this format.
 */
export function scopeCtxMetadataKey(accountId: string, kind: ResourceKind, id: string): string {
  return `${accountId}${kind}${id}`;
}

/**
 * Compose the bulkGet result key. External — callers index Map entries by this.
 */
export function ctxMetadataResultKey(kind: ResourceKind, id: string): string {
  return `${kind}:${id}`;
}

function validateAccountId(accountId: string): void {
  if (accountId == null || accountId === '') {
    throw new CtxMetadataValidationError(
      'INVALID_ARGUMENT',
      'ctx_metadata requires an account scope. No-account tools (provide_performance_feedback, ' +
        'list_creative_formats) cannot use ctx_metadata.'
    );
  }
  if (!VALID_KEY_SEGMENT.test(accountId)) {
    throw new CtxMetadataValidationError(
      'INVALID_ARGUMENT',
      `Invalid accountId shape: must match ${VALID_KEY_SEGMENT}`
    );
  }
}

function validateResourceId(id: string): void {
  if (id == null || id === '') {
    throw new CtxMetadataValidationError('INVALID_ARGUMENT', 'ctx_metadata resource id must be non-empty');
  }
  if (!VALID_KEY_SEGMENT.test(id)) {
    throw new CtxMetadataValidationError(
      'INVALID_ARGUMENT',
      `Invalid resource id shape: must match ${VALID_KEY_SEGMENT}`
    );
  }
}

function validateResourceKind(kind: ResourceKind): void {
  if (!ALL_RESOURCE_KINDS.includes(kind)) {
    throw new CtxMetadataValidationError('INVALID_ARGUMENT', `Unknown ctx_metadata resource kind: ${kind}`);
  }
}

function tagInternal<T>(value: T): T {
  if (value == null || typeof value !== 'object') return value;
  Object.defineProperty(value as object, ADCP_INTERNAL_TAG, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return value;
}

/**
 * Build a CtxMetadataStore wrapping a backend.
 *
 * Memory backend is fine for single-process dev. Cluster deployments
 * MUST use `pgCtxMetadataStore` — silent ctx_metadata loss after a
 * rolling restart produces "package not found" errors that look like
 * publisher bugs and run for weeks.
 */
export function createCtxMetadataStore(config: CtxMetadataStoreConfig): CtxMetadataStore {
  const backend = config.backend;
  const maxValueBytes = config.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES;

  return {
    async get(accountId, kind, id) {
      validateAccountId(accountId);
      validateResourceKind(kind);
      validateResourceId(id);
      const entry = await backend.get(scopeCtxMetadataKey(accountId, kind, id));
      if (!entry) return undefined;
      if (entry.expiresAt != null && entry.expiresAt < Math.floor(Date.now() / 1000)) {
        return undefined;
      }
      return tagInternal(entry.value);
    },

    async bulkGet(accountId, refs) {
      validateAccountId(accountId);
      if (refs.length === 0) return new Map();
      const scopedKeys: string[] = [];
      const scopedToResultKey = new Map<string, string>();
      for (const ref of refs) {
        validateResourceKind(ref.kind);
        validateResourceId(ref.id);
        const scoped = scopeCtxMetadataKey(accountId, ref.kind, ref.id);
        scopedKeys.push(scoped);
        scopedToResultKey.set(scoped, ctxMetadataResultKey(ref.kind, ref.id));
      }
      const entries = await backend.bulkGet(scopedKeys);
      const result = new Map<string, unknown>();
      const nowSeconds = Math.floor(Date.now() / 1000);
      for (const [scopedKey, entry] of entries) {
        if (entry.expiresAt != null && entry.expiresAt < nowSeconds) continue;
        const resultKey = scopedToResultKey.get(scopedKey);
        if (resultKey != null) result.set(resultKey, tagInternal(entry.value));
      }
      return result;
    },

    async set(accountId, kind, id, value, ttlSeconds) {
      validateAccountId(accountId);
      validateResourceKind(kind);
      validateResourceId(id);
      if (ttlSeconds != null) {
        if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
          throw new CtxMetadataValidationError('INVALID_ARGUMENT', 'ttlSeconds must be a positive finite number');
        }
        if (ttlSeconds > MAX_TTL_SECONDS) {
          throw new CtxMetadataValidationError(
            'INVALID_ARGUMENT',
            `ttlSeconds exceeds the 30-day maximum (${MAX_TTL_SECONDS}s)`
          );
        }
      }
      const serialized = JSON.stringify(value);
      if (serialized == null) {
        throw new CtxMetadataValidationError(
          'INVALID_ARGUMENT',
          'ctx_metadata value must be JSON-serializable (got undefined / function / symbol)'
        );
      }
      const byteLen = Buffer.byteLength(serialized, 'utf8');
      if (byteLen > maxValueBytes) {
        throw new CtxMetadataValidationError(
          'CTX_METADATA_TOO_LARGE',
          `ctx_metadata blob is ${byteLen} bytes, exceeds the configured cap of ${maxValueBytes} bytes ` +
            `for ${kind}:${id}. Offload large payloads to your own storage and reference by ID.`
        );
      }
      const expiresAt = ttlSeconds != null ? Math.floor(Date.now() / 1000) + ttlSeconds : undefined;
      // Preserve any prior `resource` from the framework-managed entry —
      // adopter `set()` only mutates `value`. The dispatch seam writes
      // resource via `setEntry`.
      const prior = await backend.get(scopeCtxMetadataKey(accountId, kind, id));
      const next: CtxMetadataEntry = {
        value,
        ...(prior?.resource !== undefined && { resource: prior.resource }),
        ...(expiresAt !== undefined
          ? { expiresAt }
          : prior?.expiresAt !== undefined
            ? { expiresAt: prior.expiresAt }
            : {}),
      };
      await backend.put(scopeCtxMetadataKey(accountId, kind, id), next);
    },

    async setEntry(accountId, kind, id, entry) {
      validateAccountId(accountId);
      validateResourceKind(kind);
      validateResourceId(id);
      // Cap applied to the COMBINED serialization (value + resource) since
      // both round-trip together. Use the same upstream message so adopters
      // see the same diagnostic surface.
      const serialized = JSON.stringify({ value: entry.value, resource: entry.resource });
      const byteLen = Buffer.byteLength(serialized, 'utf8');
      if (byteLen > maxValueBytes) {
        throw new CtxMetadataValidationError(
          'CTX_METADATA_TOO_LARGE',
          `ctx_metadata combined blob is ${byteLen} bytes, exceeds the configured cap of ${maxValueBytes} bytes ` +
            `for ${kind}:${id}. Offload large payloads to your own storage and reference by ID.`
        );
      }
      await backend.put(scopeCtxMetadataKey(accountId, kind, id), entry);
    },

    async setResource(accountId, kind, id, resource, publisherCtxMetadata) {
      validateAccountId(accountId);
      validateResourceKind(kind);
      validateResourceId(id);
      const scopedKey = scopeCtxMetadataKey(accountId, kind, id);
      const prior = await backend.get(scopedKey);
      // Resolve the value to persist:
      //   - publisher returned ctx_metadata on the wire shape → use it (overrides prior)
      //   - publisher omitted ctx_metadata → preserve prior value (don't clobber)
      //   - no prior, no publisher value → store null
      const nextValue =
        publisherCtxMetadata !== undefined && publisherCtxMetadata !== null
          ? publisherCtxMetadata
          : (prior?.value ?? null);
      const nextEntry: CtxMetadataEntry = {
        value: nextValue,
        resource,
        ...(prior?.expiresAt !== undefined && { expiresAt: prior.expiresAt }),
      };
      // Apply the same size cap used by setEntry.
      const serialized = JSON.stringify({ value: nextEntry.value, resource: nextEntry.resource });
      const byteLen = Buffer.byteLength(serialized, 'utf8');
      if (byteLen > maxValueBytes) {
        throw new CtxMetadataValidationError(
          'CTX_METADATA_TOO_LARGE',
          `ctx_metadata combined blob is ${byteLen} bytes, exceeds the configured cap of ${maxValueBytes} bytes ` +
            `for ${kind}:${id}. Offload large payloads to your own storage and reference by ID.`
        );
      }
      await backend.put(scopedKey, nextEntry);
    },

    async getEntry(accountId, kind, id) {
      validateAccountId(accountId);
      validateResourceKind(kind);
      validateResourceId(id);
      const entry = await backend.get(scopeCtxMetadataKey(accountId, kind, id));
      if (!entry) return undefined;
      if (entry.expiresAt != null && entry.expiresAt < Math.floor(Date.now() / 1000)) {
        return undefined;
      }
      return entry;
    },

    async bulkGetEntries(accountId, refs) {
      validateAccountId(accountId);
      if (refs.length === 0) return new Map();
      const scopedKeys: string[] = [];
      const scopedToResultKey = new Map<string, string>();
      for (const ref of refs) {
        validateResourceKind(ref.kind);
        validateResourceId(ref.id);
        const scoped = scopeCtxMetadataKey(accountId, ref.kind, ref.id);
        scopedKeys.push(scoped);
        scopedToResultKey.set(scoped, ctxMetadataResultKey(ref.kind, ref.id));
      }
      const entries = await backend.bulkGet(scopedKeys);
      const result = new Map<string, CtxMetadataEntry>();
      const nowSeconds = Math.floor(Date.now() / 1000);
      for (const [scopedKey, entry] of entries) {
        if (entry.expiresAt != null && entry.expiresAt < nowSeconds) continue;
        const resultKey = scopedToResultKey.get(scopedKey);
        if (resultKey != null) result.set(resultKey, entry);
      }
      return result;
    },

    async delete(accountId, kind, id) {
      validateAccountId(accountId);
      validateResourceKind(kind);
      validateResourceId(id);
      await backend.delete(scopeCtxMetadataKey(accountId, kind, id));
    },

    async probe() {
      if (backend.probe) await backend.probe();
    },

    async close() {
      if (backend.close) await backend.close();
    },

    async clearAll() {
      if (!backend.clearAll) {
        throw new Error(
          'ctx_metadata backend does not support clearAll(). ' +
            'Production backends (e.g., shared Postgres) should refuse this; use memory backend for tests.'
        );
      }
      await backend.clearAll();
    },
  };
}
