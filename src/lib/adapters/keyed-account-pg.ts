import type { KeyedAccountBackend, KeyedAccountRecord } from './keyed-account-store';

/** Minimal query surface supported by node-postgres pools and connection adapters. */
export interface KeyedAccountPgQueryable {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: Row[] }>;
}
export interface KeyedAccountPgConnection extends KeyedAccountPgQueryable {
  release(discard?: boolean | Error): void;
}
export interface KeyedAccountPgPool extends KeyedAccountPgQueryable {
  connect(): Promise<KeyedAccountPgConnection>;
}

async function storage<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    throw new Error('Keyed account database operation failed.', { cause });
  }
}

export interface KeyedAccountPgOptions {
  tableName?: string;
  /** Maximum wait for a principal row lock. Default 2000 ms. */
  lockTimeoutMs?: number;
  /** Maximum duration of each database statement. Default 30000 ms. */
  statementTimeoutMs?: number;
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

// Share queues across backend instances using the same pool. Wait before acquiring a connection.
const poolQueues = new WeakMap<KeyedAccountPgPool, Map<string, Promise<void>>>();
async function queued<T>(pool: KeyedAccountPgPool, key: string, run: () => Promise<T>): Promise<T> {
  let queues = poolQueues.get(pool);
  if (!queues) {
    queues = new Map();
    poolQueues.set(pool, queues);
  }
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => {
    release = resolve;
  });
  queues.set(key, current);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (queues.get(key) === current) queues.delete(key);
  }
}

/** Row locks serialize every read-modify-write for a principal, including first creation across replicas. */
export function keyedAccountPgBackend<TCtxMeta = Record<string, unknown>>(
  pool: KeyedAccountPgPool,
  options: KeyedAccountPgOptions = {}
): KeyedAccountBackend<TCtxMeta> {
  const table = tableName(options);
  const lockTimeout = options.lockTimeoutMs ?? 2000;
  const statementTimeout = options.statementTimeoutMs ?? 30000;
  if (![lockTimeout, statementTimeout].every(value => Number.isSafeInteger(value) && value > 0))
    throw new Error('Keyed account database timeouts must be positive safe integers.');
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
      return queued(pool, JSON.stringify([table, scope]), async () => {
        const connection = await storage(() => pool.connect());
        let discard = false;
        try {
          await storage(() => connection.query('BEGIN'));
          await storage(() =>
            connection.query("SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)", [
              `${lockTimeout}ms`,
              `${statementTimeout}ms`,
            ])
          );
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
      });
    },
  };
}
