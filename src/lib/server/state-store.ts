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

/**
 * In-memory state store for development and testing.
 *
 * State is lost when the process restarts. Use PostgresStateStore for production.
 */
export class InMemoryStateStore implements AdcpStateStore {
  private collections = new Map<string, Map<string, Record<string, unknown>>>();
  private readonly maxDocumentBytes: number;

  constructor(options?: InMemoryStateStoreOptions) {
    this.maxDocumentBytes = options?.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  }

  private getCollection(collection: string): Map<string, Record<string, unknown>> {
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
    const doc = this.getCollection(collection).get(id);
    return doc ? ({ ...doc } as T) : null;
  }

  async put(collection: string, id: string, data: Record<string, unknown>): Promise<void> {
    validateWrite(collection, id, data, this.maxDocumentBytes);
    this.getCollection(collection).set(id, { ...data });
  }

  async patch(collection: string, id: string, partial: Record<string, unknown>): Promise<void> {
    validateWrite(collection, id, partial, this.maxDocumentBytes);
    const col = this.getCollection(collection);
    const existing = col.get(id);
    col.set(id, { ...(existing ?? {}), ...partial });
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

    // Build id+data entries for stable cursor tracking
    let entries = [...col.entries()].map(([id, data]) => ({ id, data: data as T }));

    // Apply filter (exact match on fields)
    if (options?.filter) {
      for (const [key, value] of Object.entries(options.filter)) {
        entries = entries.filter(e => e.data[key] === value);
      }
    }

    // Apply cursor (skip entries at or before cursor id)
    if (options?.cursor) {
      const idx = entries.findIndex(e => e.id === options.cursor);
      if (idx >= 0) {
        entries = entries.slice(idx + 1);
      }
    }

    // Apply limit
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
  };
}
