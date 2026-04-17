/**
 * PostgreSQL-backed state store for distributed AdCP servers.
 *
 * Replaces InMemoryStateStore when running multiple server instances behind
 * a load balancer. Domain objects are stored in a shared JSONB table so any
 * instance can read or write state regardless of which instance handled
 * the original request.
 *
 * @example
 * ```typescript
 * import { Pool } from 'pg';
 * import { PostgresStateStore, createAdcpServer, serve } from '@adcp/client';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const stateStore = new PostgresStateStore(pool);
 *
 * // Run migration once at startup
 * await pool.query(getAdcpStateMigration());
 *
 * serve(() => createAdcpServer({
 *   name: 'My Publisher', version: '1.0.0',
 *   stateStore,
 *   mediaBuy: {
 *     createMediaBuy: async (params, ctx) => {
 *       const buy = { media_buy_id: 'mb_1', status: 'active', packages: [] };
 *       await ctx.store.put('media_buys', buy.media_buy_id, buy);
 *       return buy;
 *     },
 *   },
 * }));
 * ```
 */

import type { PgQueryable } from './postgres-task-store';
import {
  DEFAULT_MAX_DOCUMENT_BYTES,
  createSessionedStore,
  validateCollection,
  validateId,
  validateWrite,
  type AdcpStateStore,
  type ListOptions,
  type ListResult,
} from './state-store';

export interface PostgresStateStoreOptions {
  /** Table name. Must contain only lowercase letters, digits, and underscores. Defaults to `"adcp_state"`. */
  tableName?: string;
  /** Max bytes per document. Defaults to {@link DEFAULT_MAX_DOCUMENT_BYTES}. */
  maxDocumentBytes?: number;
}

const DEFAULT_TABLE = 'adcp_state';
const VALID_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

/**
 * Generate the SQL DDL for the state store table.
 */
export function getAdcpStateMigration(tableName = DEFAULT_TABLE): string {
  if (!VALID_IDENTIFIER.test(tableName)) {
    throw new Error(`Invalid table name: "${tableName}". Must match /^[a-z_][a-z0-9_]*$/.`);
  }

  return `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      collection    TEXT NOT NULL,
      id            TEXT NOT NULL,
      data          JSONB NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      PRIMARY KEY (collection, id)
    );

    CREATE INDEX IF NOT EXISTS idx_${tableName}_collection
      ON ${tableName}(collection);

    CREATE INDEX IF NOT EXISTS idx_${tableName}_updated
      ON ${tableName}(updated_at);
  `;
}

/** The migration SQL as a constant for the default table name. */
export const ADCP_STATE_MIGRATION = getAdcpStateMigration();

export class PostgresStateStore implements AdcpStateStore {
  private readonly db: PgQueryable;
  private readonly table: string;
  private readonly maxDocumentBytes: number;

  constructor(db: PgQueryable, options?: PostgresStateStoreOptions) {
    this.db = db;
    this.table = options?.tableName ?? DEFAULT_TABLE;
    this.maxDocumentBytes = options?.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
    if (!VALID_IDENTIFIER.test(this.table)) {
      throw new Error(`Invalid table name: "${this.table}". Must match /^[a-z_][a-z0-9_]*$/.`);
    }
  }

  async get<T extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    id: string
  ): Promise<T | null> {
    validateCollection(collection);
    validateId(id);
    const { rows } = await this.db.query(`SELECT data FROM ${this.table} WHERE collection = $1 AND id = $2`, [
      collection,
      id,
    ]);
    if (rows.length === 0) return null;
    return rows[0]!.data as T;
  }

  async put(collection: string, id: string, data: Record<string, unknown>): Promise<void> {
    const serialized = validateWrite(collection, id, data, this.maxDocumentBytes);
    await this.db.query(
      `INSERT INTO ${this.table} (collection, id, data)
       VALUES ($1, $2, $3)
       ON CONFLICT (collection, id)
       DO UPDATE SET data = $3, updated_at = NOW()`,
      [collection, id, serialized]
    );
  }

  async patch(collection: string, id: string, partial: Record<string, unknown>): Promise<void> {
    const serialized = validateWrite(collection, id, partial, this.maxDocumentBytes);
    await this.db.query(
      `INSERT INTO ${this.table} (collection, id, data)
       VALUES ($1, $2, $3)
       ON CONFLICT (collection, id)
       DO UPDATE SET data = ${this.table}.data || $3, updated_at = NOW()`,
      [collection, id, serialized]
    );
  }

  async delete(collection: string, id: string): Promise<boolean> {
    validateCollection(collection);
    validateId(id);
    const { rowCount } = await this.db.query(`DELETE FROM ${this.table} WHERE collection = $1 AND id = $2`, [
      collection,
      id,
    ]);
    return (rowCount ?? 0) > 0;
  }

  async list<T extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    options?: ListOptions
  ): Promise<ListResult<T>> {
    validateCollection(collection);
    const limit = Math.min(options?.limit ?? PAGE_SIZE, MAX_PAGE_SIZE);
    const conditions = ['collection = $1'];
    const values: unknown[] = [collection];
    let paramIndex = 2;

    // Filter by JSONB containment
    if (options?.filter && Object.keys(options.filter).length > 0) {
      conditions.push(`data @> $${paramIndex}`);
      values.push(JSON.stringify(options.filter));
      paramIndex++;
    }

    // Cursor-based pagination (cursor = "updated_at|id")
    if (options?.cursor) {
      const parts = options.cursor.split('|', 2);
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Invalid cursor format: expected "timestamp|id"`);
      }
      const [cursorTime, cursorId] = parts;
      conditions.push(`(updated_at, id) > ($${paramIndex}::timestamptz, $${paramIndex + 1})`);
      values.push(cursorTime, cursorId);
      paramIndex += 2;
    }

    const where = conditions.join(' AND ');
    // Fetch one extra to detect hasMore
    values.push(limit + 1);

    const { rows } = await this.db.query(
      `SELECT id, data, updated_at::text AS updated_at_raw
       FROM ${this.table}
       WHERE ${where}
       ORDER BY updated_at, id
       LIMIT $${paramIndex}`,
      values
    );

    const hasMore = rows.length > limit;
    const resultRows = hasMore ? rows.slice(0, limit) : rows;
    const items = resultRows.map(r => r.data as T);

    let nextCursor: string | undefined;
    if (hasMore && resultRows.length > 0) {
      const last = resultRows[resultRows.length - 1]!;
      nextCursor = `${last.updated_at_raw as string}|${last.id as string}`;
    }

    return { items, nextCursor };
  }

  /**
   * Delete all documents in a collection.
   */
  async clearCollection(collection: string): Promise<number> {
    const { rowCount } = await this.db.query(`DELETE FROM ${this.table} WHERE collection = $1`, [collection]);
    return rowCount ?? 0;
  }

  scoped(sessionKey: string): AdcpStateStore {
    return createSessionedStore(this, sessionKey);
  }
}
