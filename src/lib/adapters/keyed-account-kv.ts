import { AdcpError } from '../server/decisioning/async-outcome';
import type { KeyedAccountBackend, KeyedAccountRecord } from './keyed-account-store';

async function storage<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    throw new Error('Keyed account KV operation failed.', { cause });
  }
}

/** KV operations must be linearizable, shared across replicas, and have no expiry. */
export interface KeyedAccountKvClient {
  get(key: string): Promise<string | null>;
  /** Atomically replace exactly expected (null means absent). Return false on a concurrent write. */
  compareAndSwap(key: string, expected: string | null, value: string): Promise<boolean>;
}

/**
 * Durable KV adapter. A conflicted transaction retries its pure update callback.
 * createAccount/updateAccount MUST NOT perform external writes or other side effects.
 */
export function keyedAccountKvBackend<TCtxMeta = Record<string, unknown>>(
  client: KeyedAccountKvClient,
  options: { prefix?: string } = {}
): KeyedAccountBackend<TCtxMeta> {
  const key = (scope: string) => `${options.prefix ?? 'adcp:keyed-accounts:'}${scope}`;
  const decode = (value: string | null): KeyedAccountRecord<TCtxMeta>[] => {
    if (value === null) return [];
    const records: unknown = JSON.parse(value);
    if (!Array.isArray(records)) throw new Error('Invalid keyed account KV record');
    return records as KeyedAccountRecord<TCtxMeta>[];
  };
  return {
    async read(scope) {
      return storage(async () => decode(await client.get(key(scope))));
    },
    async transaction(scope, update) {
      for (let attempt = 0; attempt < 32; attempt++) {
        const { previous, records } = await storage(async () => {
          const previous = await client.get(key(scope));
          return { previous, records: decode(previous) };
        });
        const result = await update(records);
        if (result.commit === false) return result.value;
        if (await storage(() => client.compareAndSwap(key(scope), previous, JSON.stringify(result.records))))
          return result.value;
      }
      throw new AdcpError('SERVICE_UNAVAILABLE', { message: 'Account storage contention; retry the request.' });
    },
  };
}
