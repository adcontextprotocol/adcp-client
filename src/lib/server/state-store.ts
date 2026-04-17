/**
 * Pluggable state store for AdCP server domain objects.
 *
 * Sellers use this to persist media buys, accounts, creatives, and other
 * domain state across stateless HTTP requests. The store is a generic
 * document store keyed by collection + id.
 *
 * `createAdcpServer` passes the store to handlers via `ctx.store`.
 * The in-memory implementation works for development; use PostgresStateStore
 * for production.
 *
 * @example
 * ```typescript
 * import { createAdcpServer, InMemoryStateStore } from '@adcp/client/server';
 *
 * const store = new InMemoryStateStore();
 *
 * const server = createAdcpServer({
 *   name: 'My Publisher', version: '1.0.0',
 *   stateStore: store,
 *   mediaBuy: {
 *     createMediaBuy: async (params, ctx) => {
 *       const buy = { media_buy_id: `mb_${Date.now()}`, status: 'active', packages: [] };
 *       await ctx.store.put('media_buys', buy.media_buy_id, buy);
 *       return buy;
 *     },
 *     getMediaBuys: async (params, ctx) => {
 *       const buys = await ctx.store.list('media_buys');
 *       return { media_buys: buys.items };
 *     },
 *   },
 * });
 * ```
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

import { ADCPError } from '../errors';

export type StateErrorCode = 'INVALID_COLLECTION' | 'INVALID_ID' | 'PAYLOAD_TOO_LARGE' | 'NOT_FOUND' | 'BACKEND_ERROR';

/**
 * Typed error thrown by state-store implementations for validation, size-limit,
 * and backend failures. Extends {@link ADCPError} so callers can use the
 * standard `isADCPError` / `extractErrorInfo` helpers.
 */
export class StateError extends ADCPError {
  readonly code: StateErrorCode;

  constructor(code: StateErrorCode, message: string, details?: unknown) {
    super(message, details);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Max bytes (UTF-8) allowed per document. Overridable per-store via options. */
export const DEFAULT_MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

/** 1–256 ASCII letters, digits, or any of `_ - . :`. Prose description is in error messages. */
const KEY_PATTERN = /^[A-Za-z0-9_.\-:]{1,256}$/;
const KEY_DESCRIPTION = 'letters, digits, or `_ . - :` (1–256 chars)';

/**
 * Stricter pattern for sessioned-store sessionKeys and ids — excludes `:` so
 * that `sessionKey + "::" + id` is unambiguous. Without this, `"alice:" + "::" + "x"`
 * would collide with `"alice" + "::" + ":x"` and let tenants read each other's rows.
 */
const SESSION_KEY_PATTERN = /^[A-Za-z0-9_.\-]{1,256}$/;
const SESSION_KEY_DESCRIPTION = 'letters, digits, or `_ . -` (1–256 chars; `:` is reserved for scope paths)';

/** Clamp attacker-controlled input before interpolating into error messages or logs. */
function safeForMessage(value: unknown): string {
  const raw = typeof value === 'string' ? value : String(value);
  return raw.slice(0, 64).replace(/[^\x20-\x7E]/g, '?');
}

function validateKey(kind: 'collection' | 'id', value: string): void {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    const code: StateErrorCode = kind === 'collection' ? 'INVALID_COLLECTION' : 'INVALID_ID';
    throw new StateError(code, `${kind} "${safeForMessage(value)}" is invalid. Use ${KEY_DESCRIPTION}.`);
  }
}

export function validateCollection(collection: string): void {
  validateKey('collection', collection);
}

export function validateId(id: string): void {
  validateKey('id', id);
}

export function validatePayloadSize(data: unknown, maxBytes: number): void {
  measureAndCheckSize(data, maxBytes);
}

/**
 * Measure the serialized size of `data` and throw if it exceeds `maxBytes`.
 * Returns the serialized form so callers can pass it to `db.query` without re-stringifying.
 */
function measureAndCheckSize(data: unknown, maxBytes: number): string {
  const serialized = JSON.stringify(data) ?? '';
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > maxBytes) {
    throw new StateError(
      'PAYLOAD_TOO_LARGE',
      `Document is ${bytes} bytes; exceeds limit of ${maxBytes} bytes. Split the document or raise maxDocumentBytes.`
    );
  }
  return serialized;
}

/**
 * Validate collection + id + payload size. Returns the serialized payload so
 * callers (e.g., PostgresStateStore) can reuse it without re-stringifying.
 */
export function validateWrite(collection: string, id: string, data: unknown, maxBytes: number): string {
  validateKey('collection', collection);
  validateKey('id', id);
  return measureAndCheckSize(data, maxBytes);
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ListOptions {
  /** Filter by field values (exact match). */
  filter?: Record<string, unknown>;
  /** Maximum items to return. */
  limit?: number;
  /** Cursor from a previous list call. */
  cursor?: string;
}

export interface ListResult<T = Record<string, unknown>> {
  items: T[];
  nextCursor?: string;
}

/**
 * Document and its row version, returned by {@link AdcpStateStore.getWithVersion}.
 *
 * `version` is a monotonically increasing integer that starts at `1` on first
 * write and increments by `1` on every `put`/`patch`/`putIfMatch`. Use it with
 * `putIfMatch` to implement optimistic concurrency.
 */
export interface VersionedDocument<T = Record<string, unknown>> {
  data: T;
  version: number;
}

/**
 * Result of an optimistic-concurrency write. Split on `ok` — success gives you
 * the new row version; failure gives you the current version the store has on
 * disk (or `null` if the row doesn't exist) so you can re-read, re-compute, and retry.
 *
 * **Conflict semantics**: `currentVersion` is a best-effort snapshot of the row
 * at conflict-report time, which may be later than the exact moment the CAS
 * failed — another writer can slip in between the failed write and the follow-up
 * read. This is fine for the retry loop in {@link patchWithRetry} (which just
 * re-reads anyway). Direct callers using `currentVersion` for anything beyond
 * "retry if it changed" should account for that race.
 */
export type PutIfMatchResult = { ok: true; version: number } | { ok: false; currentVersion: number | null };

/**
 * Generic document store for AdCP domain objects.
 *
 * Collections are logical groupings (e.g., 'media_buys', 'accounts', 'creatives').
 * Each document is identified by collection + id.
 */
export interface AdcpStateStore {
  /** Get a document by collection and id. Returns null if not found. */
  get<T extends Record<string, unknown> = Record<string, unknown>>(collection: string, id: string): Promise<T | null>;

  /** Create or replace a document (upsert semantics). */
  put(collection: string, id: string, data: Record<string, unknown>): Promise<void>;

  /**
   * Merge fields into an existing document. Creates the document if it doesn't exist.
   * Only top-level fields are merged — nested objects are replaced, not deep-merged.
   */
  patch(collection: string, id: string, partial: Record<string, unknown>): Promise<void>;

  /** Delete a document. Returns true if it existed. */
  delete(collection: string, id: string): Promise<boolean>;

  /** List documents in a collection with optional filtering and pagination. */
  list<T extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    options?: ListOptions
  ): Promise<ListResult<T>>;

  /**
   * Convenience method for built-in stores: returns a session-scoped view.
   * Optional on the interface so custom `AdcpStateStore` implementations
   * aren't forced to implement it — callers who need the wrapper on any
   * store should use {@link scopedStore} instead, which handles the fallback.
   */
  scoped?(sessionKey: string): AdcpStateStore;

  /**
   * Read a document with its current row version. Returns `null` if the row
   * doesn't exist. Optional on the interface — custom stores that don't
   * track versions don't have to implement it. Use {@link patchWithRetry} to
   * guard against read-modify-write races without calling this directly.
   */
  getWithVersion?<T extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    id: string
  ): Promise<VersionedDocument<T> | null>;

  /**
   * Atomic compare-and-swap write. Succeeds only if the row's current version
   * equals `expectedVersion` (or if the row doesn't exist and `expectedVersion`
   * is `null`). On conflict, returns the version the store actually has so the
   * caller can re-read and retry.
   *
   * Optional on the interface — custom stores that can't implement CAS don't
   * have to. Use {@link patchWithRetry} for the common "update a field with
   * retry on conflict" case.
   */
  putIfMatch?(
    collection: string,
    id: string,
    data: Record<string, unknown>,
    expectedVersion: number | null
  ): Promise<PutIfMatchResult>;
}

/**
 * Return a session-scoped view of any `AdcpStateStore`.
 *
 * Prefers `store.scoped(sessionKey)` when the store defines it; otherwise
 * wraps with {@link createSessionedStore}. Use this in SDK code and skills
 * so custom store implementations work without requiring them to implement
 * `scoped` themselves.
 *
 * ```ts
 * import { scopedStore } from '@adcp/client/server';
 *
 * const sessionStore = scopedStore(ctx.store, ctx.sessionKey!);
 * await sessionStore.put('media_buys', buyId, buy);
 * const { items } = await sessionStore.list('media_buys');
 * ```
 */
export function scopedStore(store: AdcpStateStore, sessionKey: string): AdcpStateStore {
  return store.scoped ? store.scoped(sessionKey) : createSessionedStore(store, sessionKey);
}

// ---------------------------------------------------------------------------
// InMemoryStateStore
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

export interface InMemoryStateStoreOptions {
  /** Max bytes per document. Defaults to {@link DEFAULT_MAX_DOCUMENT_BYTES}. */
  maxDocumentBytes?: number;
}

interface VersionedRow {
  data: Record<string, unknown>;
  version: number;
}

/**
 * In-memory state store for development and testing.
 *
 * State is lost when the process restarts. Use PostgresStateStore for production.
 */
export class InMemoryStateStore implements AdcpStateStore {
  private collections = new Map<string, Map<string, VersionedRow>>();
  private readonly maxDocumentBytes: number;

  constructor(options?: InMemoryStateStoreOptions) {
    this.maxDocumentBytes = options?.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  }

  private getCollection(collection: string): Map<string, VersionedRow> {
    let col = this.collections.get(collection);
    if (!col) {
      col = new Map();
      this.collections.set(collection, col);
    }
    return col;
  }

  async get<T extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    id: string
  ): Promise<T | null> {
    validateCollection(collection);
    validateId(id);
    const row = this.getCollection(collection).get(id);
    return row ? ({ ...row.data } as T) : null;
  }

  async getWithVersion<T extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    id: string
  ): Promise<VersionedDocument<T> | null> {
    validateCollection(collection);
    validateId(id);
    const row = this.getCollection(collection).get(id);
    return row ? { data: { ...row.data } as T, version: row.version } : null;
  }

  async put(collection: string, id: string, data: Record<string, unknown>): Promise<void> {
    validateWrite(collection, id, data, this.maxDocumentBytes);
    const col = this.getCollection(collection);
    const existing = col.get(id);
    col.set(id, { data: { ...data }, version: (existing?.version ?? 0) + 1 });
  }

  async putIfMatch(
    collection: string,
    id: string,
    data: Record<string, unknown>,
    expectedVersion: number | null
  ): Promise<PutIfMatchResult> {
    validateWrite(collection, id, data, this.maxDocumentBytes);
    const col = this.getCollection(collection);
    const existing = col.get(id);
    const currentVersion = existing?.version ?? null;
    if (currentVersion !== expectedVersion) {
      return { ok: false, currentVersion };
    }
    const nextVersion = (existing?.version ?? 0) + 1;
    col.set(id, { data: { ...data }, version: nextVersion });
    return { ok: true, version: nextVersion };
  }

  async patch(collection: string, id: string, partial: Record<string, unknown>): Promise<void> {
    validateWrite(collection, id, partial, this.maxDocumentBytes);
    const col = this.getCollection(collection);
    const existing = col.get(id);
    col.set(id, {
      data: { ...(existing?.data ?? {}), ...partial },
      version: (existing?.version ?? 0) + 1,
    });
  }

  async delete(collection: string, id: string): Promise<boolean> {
    validateCollection(collection);
    validateId(id);
    return this.getCollection(collection).delete(id);
  }

  async list<T extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    options?: ListOptions
  ): Promise<ListResult<T>> {
    validateCollection(collection);
    const col = this.getCollection(collection);

    let entries = [...col.entries()].map(([id, row]) => ({ id, data: row.data as T }));

    if (options?.filter) {
      for (const [key, value] of Object.entries(options.filter)) {
        entries = entries.filter(e => e.data[key] === value);
      }
    }

    if (options?.cursor) {
      const idx = entries.findIndex(e => e.id === options.cursor);
      if (idx >= 0) {
        entries = entries.slice(idx + 1);
      }
    }

    const limit = Math.min(options?.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const hasMore = entries.length > limit;
    entries = entries.slice(0, limit);

    const nextCursor = hasMore && entries.length > 0 ? entries[entries.length - 1]!.id : undefined;

    return { items: entries.map(e => ({ ...e.data })), nextCursor };
  }

  /** Clear all data. Useful in tests. */
  clear(): void {
    this.collections.clear();
  }

  /** Get the number of documents in a collection. */
  size(collection: string): number {
    return this.getCollection(collection).size;
  }

  scoped(sessionKey: string): AdcpStateStore {
    return createSessionedStore(this, sessionKey);
  }
}

// ---------------------------------------------------------------------------
// Sessioned store wrapper
// ---------------------------------------------------------------------------

/**
 * Marker field injected by {@link createSessionedStore} into every document
 * it writes. Sellers reading the underlying store directly will see it.
 */
export const SESSION_KEY_FIELD = '_session_key';

/** Reserved scope-path separator. `:` is forbidden in sessionKeys and ids so `::` is unambiguous. */
const SESSION_ID_SEPARATOR = '::';

function validateSessionPart(kind: 'sessionKey' | 'id', value: string): void {
  if (typeof value !== 'string' || !SESSION_KEY_PATTERN.test(value)) {
    throw new StateError(
      'INVALID_ID',
      `${kind} "${safeForMessage(value)}" is invalid. Use ${SESSION_KEY_DESCRIPTION}.`
    );
  }
}

function stripSessionKey<T extends Record<string, unknown>>(doc: T | null): T | null {
  if (doc == null) return null;
  if (!(SESSION_KEY_FIELD in doc)) return doc;
  const { [SESSION_KEY_FIELD]: _ignored, ...rest } = doc as Record<string, unknown>;
  return rest as T;
}

function rejectReservedField(data: Record<string, unknown>): void {
  if (SESSION_KEY_FIELD in data) {
    throw new StateError(
      'INVALID_ID',
      `Payload field "${SESSION_KEY_FIELD}" is reserved by the sessioned store. Rename it in your document.`
    );
  }
}

/**
 * Wrap an AdcpStateStore so every operation is isolated to `sessionKey`.
 *
 * - **ids** are prefixed with `${sessionKey}::` before hitting the underlying store.
 * - **writes** inject `_session_key: sessionKey` into the document so `list()` can filter on it.
 * - **reads/lists** strip `_session_key` before returning documents.
 * - **list filters** always AND-in `_session_key = sessionKey`.
 *
 * `sessionKey` and caller `id`s must match {@link SESSION_KEY_PATTERN} — no `:`
 * characters — so `${sessionKey}::${id}` is unambiguous. Payloads may not include
 * the reserved `_session_key` field.
 *
 * Use this when every handler's state is scoped to a tenant/brand/session,
 * so you don't have to thread `sessionKey` through every `put`/`list` call.
 */
export function createSessionedStore(inner: AdcpStateStore, sessionKey: string): AdcpStateStore {
  validateSessionPart('sessionKey', sessionKey);

  const prefix = (id: string) => {
    validateSessionPart('id', id);
    return `${sessionKey}${SESSION_ID_SEPARATOR}${id}`;
  };

  return {
    async get<T extends Record<string, unknown> = Record<string, unknown>>(
      collection: string,
      id: string
    ): Promise<T | null> {
      const doc = await inner.get<T>(collection, prefix(id));
      return stripSessionKey(doc);
    },

    async put(collection, id, data) {
      rejectReservedField(data);
      await inner.put(collection, prefix(id), { ...data, [SESSION_KEY_FIELD]: sessionKey });
    },

    async patch(collection, id, partial) {
      rejectReservedField(partial);
      await inner.patch(collection, prefix(id), { ...partial, [SESSION_KEY_FIELD]: sessionKey });
    },

    async delete(collection, id) {
      return inner.delete(collection, prefix(id));
    },

    async list<T extends Record<string, unknown> = Record<string, unknown>>(
      collection: string,
      options?: ListOptions
    ): Promise<ListResult<T>> {
      const mergedFilter = {
        ...(options?.filter ?? {}),
        [SESSION_KEY_FIELD]: sessionKey,
      };
      const { items, nextCursor } = await inner.list<T>(collection, {
        ...options,
        filter: mergedFilter,
      });
      const stripped = items.map(item => stripSessionKey(item) as T);
      return nextCursor !== undefined ? { items: stripped, nextCursor } : { items: stripped };
    },

    // Proxy optimistic-concurrency methods when the inner store supports them.
    // Capture method references at wrap time (bound to `inner`) so runtime
    // reassignment or `this`-sensitive implementations like PostgresStateStore
    // can't desync.
    ...(() => {
      const innerGetWithVersion = inner.getWithVersion?.bind(inner);
      const innerPutIfMatch = inner.putIfMatch?.bind(inner);
      return {
        ...(innerGetWithVersion && {
          async getWithVersion<T extends Record<string, unknown> = Record<string, unknown>>(
            collection: string,
            id: string
          ): Promise<VersionedDocument<T> | null> {
            const result = await innerGetWithVersion<T>(collection, prefix(id));
            if (result == null) return null;
            const stripped = stripSessionKey(result.data);
            return stripped == null ? null : { data: stripped as T, version: result.version };
          },
        }),
        ...(innerPutIfMatch && {
          async putIfMatch(
            collection: string,
            id: string,
            data: Record<string, unknown>,
            expectedVersion: number | null
          ): Promise<PutIfMatchResult> {
            rejectReservedField(data);
            return innerPutIfMatch(
              collection,
              prefix(id),
              { ...data, [SESSION_KEY_FIELD]: sessionKey },
              expectedVersion
            );
          },
        }),
      };
    })(),
  };
}

// ---------------------------------------------------------------------------
// patchWithRetry helper
// ---------------------------------------------------------------------------

export interface PatchWithRetryOptions {
  /** Max retry attempts on version conflict. Defaults to 5. */
  maxAttempts?: number;

  /**
   * Called to compute a millisecond delay before the next attempt. Receives the
   * attempt number that just failed (1-indexed). Defaults to jittered exponential
   * backoff: `Math.random() * (1 << attempt)` (0–2 ms after 1, 0–4 ms after 2, …).
   * Return `0` (or pass a function that does) to disable backoff.
   */
  backoffMs?: (attempt: number) => number;

  /**
   * When the row is deleted between the initial read and the write, `patchWithRetry`
   * normally aborts with `PatchConflictError` to avoid silently resurrecting a
   * deleted document. Set to `true` to treat the post-delete state as a fresh
   * insert (re-running `update(null)` and inserting the result).
   *
   * Default: `false`.
   */
  allowResurrection?: boolean;
}

const defaultBackoffMs = (attempt: number) => Math.random() * (1 << attempt);

/**
 * Error thrown when `patchWithRetry` exceeds `maxAttempts` consecutive version conflicts,
 * or when the row was deleted between the initial read and the write and
 * `allowResurrection` is not set.
 */
export class PatchConflictError extends ADCPError {
  readonly code = 'PATCH_CONFLICT';
  constructor(
    readonly collection: string,
    readonly id: string,
    readonly attempts: number,
    readonly reason: 'max_attempts_exceeded' | 'deleted_during_retry',
    readonly lastObservedVersion: number | null
  ) {
    super(
      reason === 'deleted_during_retry'
        ? `patchWithRetry(${collection}, ${id}): row was deleted between read and write. ` +
            `Pass {allowResurrection: true} if you want to re-insert it.`
        : `patchWithRetry(${collection}, ${id}) exhausted ${attempts} attempts after version conflicts ` +
            `(last observed version: ${lastObservedVersion ?? 'none'}). ` +
            `Either the row has too many concurrent writers (split it), or raise {maxAttempts: N}.`
    );
  }
}

/**
 * Type guard for the conflict arm of {@link PutIfMatchResult}. Useful for
 * narrowing in hand-rolled retry loops.
 *
 * ```ts
 * const result = await store.putIfMatch('col', 'x', data, version);
 * if (isPutIfMatchConflict(result)) {
 *   // result.currentVersion is number | null here
 * }
 * ```
 */
export function isPutIfMatchConflict(result: PutIfMatchResult): result is { ok: false; currentVersion: number | null } {
  return result.ok === false;
}

/**
 * Read-compute-write loop that retries on version conflict, using `getWithVersion`
 * + `putIfMatch` under the hood. The right primitive for counter-like updates
 * where two handlers might read the same pre-state and otherwise lose one write.
 *
 * `update` receives the current document (or `null` if the row doesn't exist)
 * and returns the next document. Returning `null` aborts without writing.
 *
 * ```ts
 * await patchWithRetry(ctx.store, 'media_buys', 'mb_1', (current) => ({
 *   ...(current ?? {}),
 *   budget_spent: (current?.budget_spent ?? 0) + cost,
 * }));
 * ```
 *
 * Throws {@link PatchConflictError} after `maxAttempts` consecutive conflicts.
 * Throws {@link PatchConflictError} with `reason: 'deleted_during_retry'` if
 * the row is deleted between the initial read and the write (opt into
 * resurrection via `allowResurrection: true`).
 *
 * Requires the store to implement both `getWithVersion` and `putIfMatch`.
 *
 * **Mutation caveat**: the object passed to `update` is a shallow copy of the
 * stored document. Mutating nested fields in place will leak into the next
 * retry attempt — build a fresh object from the current one instead.
 *
 * **Error propagation**: if `update` throws, the exception propagates
 * immediately and no retry happens.
 *
 * **Backoff**: default is jittered exponential (low single-digit ms). Override
 * with `options.backoffMs`. Return `0` to disable.
 *
 * **Size**: each retry re-reads the full document. Avoid on rows close to
 * `maxDocumentBytes` — split into per-entity rows instead.
 */
export async function patchWithRetry<T extends Record<string, unknown> = Record<string, unknown>>(
  store: AdcpStateStore,
  collection: string,
  id: string,
  update: (current: T | null) => T | null,
  options: PatchWithRetryOptions = {}
): Promise<T | null> {
  if (!store.getWithVersion || !store.putIfMatch) {
    throw new StateError(
      'BACKEND_ERROR',
      'patchWithRetry requires a store with getWithVersion and putIfMatch. Use InMemoryStateStore or PostgresStateStore, or pass a custom store that implements both.'
    );
  }

  const maxAttempts = options.maxAttempts ?? 5;
  const backoffMs = options.backoffMs ?? defaultBackoffMs;
  const allowResurrection = options.allowResurrection ?? false;

  let sawExistingRow = false;
  let lastObservedVersion: number | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const current = await store.getWithVersion<T>(collection, id);
    if (current) {
      sawExistingRow = true;
      lastObservedVersion = current.version;
    } else if (sawExistingRow && !allowResurrection) {
      throw new PatchConflictError(collection, id, attempt, 'deleted_during_retry', lastObservedVersion);
    }

    const nextData = update(current ? current.data : null);
    if (nextData === null) return null;

    const result = await store.putIfMatch(collection, id, nextData, current ? current.version : null);
    if (result.ok) return nextData;

    if (result.currentVersion !== null) lastObservedVersion = result.currentVersion;

    if (attempt < maxAttempts) {
      const delay = backoffMs(attempt);
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new PatchConflictError(collection, id, maxAttempts, 'max_attempts_exceeded', lastObservedVersion);
}
