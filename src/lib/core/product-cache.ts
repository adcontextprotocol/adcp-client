import type { TaskResult } from './ConversationTypes';
import { accountReferenceKey } from './account-key';
import type { AccountReference } from '../types';

export interface ProductCacheOptions {
  maxEntries?: number;
  publicTtl?: number;
  accountTtl?: number;
}
interface CachedProducts {
  result: TaskResult<unknown>;
  storedAt: number;
  scope: 'public' | 'account';
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)])
    );
  return value;
}

/** Cache response scope and both feed tokens together. Account overlays never share entries. */
export class ProductCache {
  private entries = new Map<string, CachedProducts>();
  constructor(private options: ProductCacheOptions = {}) {
    if (options.maxEntries !== undefined && (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1))
      throw new Error('Product cache maxEntries must be a positive integer.');
    for (const ttl of [options.publicTtl, options.accountTtl]) {
      if (ttl !== undefined && (!Number.isFinite(ttl) || ttl < 0))
        throw new Error('Product cache TTLs must be nonnegative milliseconds.');
    }
  }
  private key(sellerScope: string, params: Record<string, unknown>): string | undefined {
    const { account, if_wholesale_feed_version: _feed, if_pricing_version: _price, ...query } = params;
    if (account !== undefined) {
      if (!account || typeof account !== 'object') return undefined;
      const ref = account as AccountReference;
      if ('account_id' in ref) {
        if (typeof ref.account_id !== 'string' || !ref.account_id) return undefined;
      } else if (!ref.brand || typeof ref.brand.domain !== 'string' || typeof ref.operator !== 'string') {
        return undefined;
      }
    }
    return JSON.stringify([
      sellerScope,
      account ? accountReferenceKey(account as AccountReference) : 'public',
      stable(query),
    ]);
  }
  read<T>(scope: string, params: Record<string, unknown>, allowExpired = false): TaskResult<T> | undefined {
    const key = this.key(scope, params);
    if (!key) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const ttl = entry.scope === 'public' ? (this.options.publicTtl ?? 60_000) : (this.options.accountTtl ?? 30_000);
    if (!allowExpired && Date.now() - entry.storedAt >= ttl) return undefined;
    return {
      ...entry.result,
      data: structuredClone(entry.result.data),
      metadata: structuredClone(entry.result.metadata),
      ...(entry.result.debug_logs && { debug_logs: structuredClone(entry.result.debug_logs) }),
    } as TaskResult<T>;
  }
  conditionalParams(scope: string, params: Record<string, unknown>): Record<string, unknown> {
    // An explicit caller validator owns its response semantics.
    if (params.if_wholesale_feed_version !== undefined || params.if_pricing_version !== undefined) return params;
    const result = this.read<Record<string, unknown>>(scope, params, true);
    const data = result?.data;
    if (typeof data?.wholesale_feed_version !== 'string') return params;
    return {
      ...params,
      if_wholesale_feed_version: data.wholesale_feed_version,
      ...(typeof data.pricing_version === 'string' && { if_pricing_version: data.pricing_version }),
    };
  }
  write<T>(
    scope: string,
    params: Record<string, unknown>,
    result: TaskResult<T>,
    conditionalSnapshot?: TaskResult<T>
  ): TaskResult<T> {
    const key = this.key(scope, params);
    if (!key) return result;
    if (!result.success || result.status !== 'completed' || !result.data || typeof result.data !== 'object')
      return result;
    const data = result.data as Record<string, unknown>;
    if (data.cache_scope !== 'public' && data.cache_scope !== 'account') {
      this.entries.delete(key); // Missing scope cannot prove cache isolation.
      return result;
    }
    if (data.cache_scope === 'account' && !params.account) {
      this.entries.delete(key);
      return result;
    }
    let completed = result;
    if (data.unchanged === true) {
      if (typeof data.wholesale_feed_version !== 'string') return result;
      const old = conditionalSnapshot?.data
        ? { result: conditionalSnapshot, scope: (conditionalSnapshot.data as Record<string, unknown>).cache_scope }
        : this.entries.get(key);
      const oldData = old?.result.data as Record<string, unknown> | undefined;
      if (
        !old ||
        old.scope !== data.cache_scope ||
        !oldData ||
        data.wholesale_feed_version !== oldData.wholesale_feed_version ||
        (data.pricing_version !== undefined && data.pricing_version !== oldData.pricing_version)
      )
        return result;
      // Only materialize our own conditional request; caller-owned validators pass through.
      if (params.if_wholesale_feed_version !== undefined || params.if_pricing_version !== undefined) return result;
      completed = { ...result, data: structuredClone(oldData) as T };
    } else if (!Array.isArray(data.products)) return result;
    if (!this.entries.has(key) && this.entries.size >= (this.options.maxEntries ?? 1000))
      this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, {
      result: {
        ...completed,
        data: structuredClone(completed.data),
        metadata: structuredClone(completed.metadata),
        ...(completed.debug_logs && { debug_logs: structuredClone(completed.debug_logs) }),
      },
      storedAt: Date.now(),
      scope: data.cache_scope,
    });
    return completed;
  }
  clear(): void {
    this.entries.clear();
  }
}
export function createProductCache(options: ProductCacheOptions = {}): ProductCache {
  return new ProductCache(options);
}
