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
  get<T extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    id: string
  ): Promise<T | null>;

  /** Create or replace a document (upsert semantics). */
  put(
    collection: string,
    id: string,
    data: Record<string, unknown>
  ): Promise<void>;

  /**
   * Merge fields into an existing document. Creates the document if it doesn't exist.
   * Only top-level fields are merged — nested objects are replaced, not deep-merged.
   */
  patch(
    collection: string,
    id: string,
    partial: Record<string, unknown>
  ): Promise<void>;

  /** Delete a document. Returns true if it existed. */
  delete(collection: string, id: string): Promise<boolean>;

  /** List documents in a collection with optional filtering and pagination. */
  list<T extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    options?: ListOptions
  ): Promise<ListResult<T>>;
}

// ---------------------------------------------------------------------------
// InMemoryStateStore
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

/**
 * In-memory state store for development and testing.
 *
 * State is lost when the process restarts. Use PostgresStateStore for production.
 */
export class InMemoryStateStore implements AdcpStateStore {
  private collections = new Map<string, Map<string, Record<string, unknown>>>();

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
    const doc = this.getCollection(collection).get(id);
    return doc ? ({ ...doc } as T) : null;
  }

  async put(
    collection: string,
    id: string,
    data: Record<string, unknown>
  ): Promise<void> {
    this.getCollection(collection).set(id, { ...data });
  }

  async patch(
    collection: string,
    id: string,
    partial: Record<string, unknown>
  ): Promise<void> {
    const col = this.getCollection(collection);
    const existing = col.get(id);
    col.set(id, { ...(existing ?? {}), ...partial });
  }

  async delete(collection: string, id: string): Promise<boolean> {
    return this.getCollection(collection).delete(id);
  }

  async list<T extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    options?: ListOptions
  ): Promise<ListResult<T>> {
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

    const nextCursor = hasMore && entries.length > 0
      ? entries[entries.length - 1]!.id
      : undefined;

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
}
