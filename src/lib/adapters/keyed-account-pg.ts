import type { Pool } from 'pg';
import type { KeyedAccountBackend, KeyedAccountRecord } from './keyed-account-store';

async function storage<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    throw new Error('Keyed account database operation failed.', { cause });
  }
}

export interface KeyedAccountPgOptions {
  tableName?: string;
}

function tableName(options: KeyedAccountPgOptions): string {
  const name = options.tableName ?? 'adcp_keyed_accounts';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(name)) throw new Error('Invalid keyed account table name');
  return `"${name}"`;
}

/** Apply once during deployment; records have no expiry. Use separate tables/namespaces per seller. */
export function getKeyedAccountMigration(options: KeyedAccountPgOptions = {}): string {
  return `CREATE TABLE IF NOT EXISTS ${tableName(options)} (scope TEXT PRIMARY KEY, records JSONB NOT NULL DEFAULT '[]'::jsonb);`;
}

/** Row locks serialize every read-modify-write for a principal, including first creation across replicas. */
export function keyedAccountPgBackend<TCtxMeta = Record<string, unknown>>(
  pool: Pool,
  options: KeyedAccountPgOptions = {}
): KeyedAccountBackend<TCtxMeta> {
  const table = tableName(options);
  return {
    async read(scope) {
      const result = await storage(() =>
        pool.query<{ records: KeyedAccountRecord<TCtxMeta>[] }>(`SELECT records FROM ${table} WHERE scope = $1`, [
          scope,
        ])
      );
      return result.rows[0]?.records ?? [];
    },
    async transaction(scope, update) {
      const connection = await storage(() => pool.connect());
      let discard = false;
      try {
        await storage(() => connection.query('BEGIN'));
        await storage(() =>
          connection.query(`INSERT INTO ${table} (scope) VALUES ($1) ON CONFLICT (scope) DO NOTHING`, [scope])
        );
        const result = await storage(() =>
          connection.query<{ records: KeyedAccountRecord<TCtxMeta>[] }>(
            `SELECT records FROM ${table} WHERE scope = $1 FOR UPDATE`,
            [scope]
          )
        );
        const updated = await update(result.rows[0]!.records);
        if (updated.commit === false) {
          await storage(() => connection.query('ROLLBACK'));
          return updated.value;
        }
        await storage(() =>
          connection.query(`UPDATE ${table} SET records = $2::jsonb WHERE scope = $1`, [
            scope,
            JSON.stringify(updated.records),
          ])
        );
        await storage(() => connection.query('COMMIT'));
        return updated.value;
      } catch (err) {
        try {
          await connection.query('ROLLBACK');
        } catch {
          discard = true;
        }
        throw err;
      } finally {
        connection.release(discard);
      }
    },
  };
}
