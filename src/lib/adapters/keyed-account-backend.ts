import { randomUUID } from 'node:crypto';
import type { Account } from '../server/decisioning/account';
import type { AccountReference } from '../types';
import type { PgQueryable } from '../server/postgres-task-store';

export interface KeyedAccountRecord<TCtxMeta = Record<string, unknown>> {
  key: string;
  ref: AccountReference;
  account: Account<TCtxMeta>;
}
export interface KeyedAccountSnapshot<TCtxMeta = Record<string, unknown>> {
  version: string;
  records: KeyedAccountRecord<TCtxMeta>[];
}

/** Persistent, non-expiring storage. KV adapters must implement atomic CAS. */
export interface KeyedAccountBackend<TCtxMeta = Record<string, unknown>> {
  load(scope: string): Promise<KeyedAccountSnapshot<TCtxMeta> | null>;
  /** Null expects absence; otherwise replace only the exact loaded version. */
  compareAndSwap(scope: string, version: string | null, records: KeyedAccountRecord<TCtxMeta>[]): Promise<boolean>;
}

/** Single-process backend; share the instance between server factories. No TTL. */
export function memoryKeyedAccountBackend<TCtxMeta = Record<string, unknown>>(): KeyedAccountBackend<TCtxMeta> {
  const data = new Map<string, KeyedAccountSnapshot<TCtxMeta>>();
  return {
    async load(scope) {
      return structuredClone(data.get(scope) ?? null);
    },
    async compareAndSwap(scope, version, records) {
      if ((data.get(scope)?.version ?? null) !== version) return false;
      data.set(scope, structuredClone({ version: randomUUID(), records }));
      return true;
    },
  };
}

export interface PgKeyedAccountBackendOptions {
  tableName?: string;
}

async function backendOperation<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    throw new Error(`Keyed account backend ${name} failed`, { cause });
  }
}
function tableFor(options: PgKeyedAccountBackendOptions): string {
  const name = options.tableName ?? 'adcp_keyed_accounts';
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new TypeError('Invalid keyed account table name');
  return `"${name}"`;
}

export function getKeyedAccountMigration(options: PgKeyedAccountBackendOptions = {}): string {
  return `CREATE TABLE IF NOT EXISTS ${tableFor(options)} (scope TEXT PRIMARY KEY, version TEXT NOT NULL, records JSONB NOT NULL);`;
}

/** Atomic SQL CAS works across processes, without an account expiry window. */
export function pgKeyedAccountBackend<TCtxMeta = Record<string, unknown>>(
  db: PgQueryable,
  options: PgKeyedAccountBackendOptions = {}
): KeyedAccountBackend<TCtxMeta> {
  const table = tableFor(options);
  return {
    async load(scope) {
      const result = await backendOperation('load', () =>
        db.query(`SELECT version, records FROM ${table} WHERE scope = $1`, [scope])
      );
      const row = result.rows[0];
      return row ? { version: row.version as string, records: row.records as KeyedAccountRecord<TCtxMeta>[] } : null;
    },
    async compareAndSwap(scope, version, records) {
      const next = randomUUID();
      const result = await backendOperation('compareAndSwap', async () =>
        version === null
          ? await db.query(
              `INSERT INTO ${table} (scope, version, records) VALUES ($1, $2, $3::jsonb) ON CONFLICT (scope) DO NOTHING`,
              [scope, next, JSON.stringify(records)]
            )
          : await db.query(`UPDATE ${table} SET version = $2, records = $3::jsonb WHERE scope = $1 AND version = $4`, [
              scope,
              next,
              JSON.stringify(records),
              version,
            ])
      );
      return result.rowCount === 1;
    },
  };
}

/** Minimal node-redis compatible API. Keys must never expire or be evicted. */
export interface KeyedAccountRedisClient {
  get(key: string): Promise<string | null>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}
const CAS = `
local current = redis.call('GET', KEYS[1])
if ARGV[1] == '' then
  if current then return 0 end
else
  if not current or cjson.decode(current).version ~= ARGV[1] then return 0 end
end
redis.call('SET', KEYS[1], ARGV[2])
return 1`;

export function redisKeyedAccountBackend<TCtxMeta = Record<string, unknown>>(
  client: KeyedAccountRedisClient,
  options: { keyPrefix?: string } = {}
): KeyedAccountBackend<TCtxMeta> {
  const prefix = options.keyPrefix ?? 'adcp:keyed-accounts:';
  return {
    async load(scope) {
      return backendOperation('load', async () => {
        const value = await client.get(prefix + scope);
        return value === null ? null : (JSON.parse(value) as KeyedAccountSnapshot<TCtxMeta>);
      });
    },
    async compareAndSwap(scope, version, records) {
      const result = await backendOperation('compareAndSwap', () =>
        client.eval(CAS, {
          keys: [prefix + scope],
          arguments: [version ?? '', JSON.stringify({ version: randomUUID(), records })],
        })
      );
      return Number(result) === 1;
    },
  };
}
