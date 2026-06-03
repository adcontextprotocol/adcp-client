/**
 * Inventory list targeting helpers for AdCP sellers.
 *
 * AdCP 3.0 carries property and collection targeting as references to
 * externally-managed lists (`PropertyListReference`, `CollectionListReference`).
 * The seller resolves those references at serve time and filters its own
 * inventory against the resolved contents.
 *
 * These helpers let a seller handler do that in one line:
 *
 * @example
 * ```typescript
 * import { resolvePropertyList, matchesPropertyList } from '@adcp/sdk/server';
 *
 * if (targeting.property_list) {
 *   const list = await resolvePropertyList(targeting.property_list);
 *   inventory = inventory.filter(p => matchesPropertyList(p.identifier, list));
 * }
 * ```
 *
 * Resolution goes through MCP (`get_property_list` / `get_collection_list`) on
 * the referenced agent — the same contract a buyer agent uses to fetch the list.
 * Matching follows the identifier and distribution-id semantics defined by the
 * AdCP property and collection specs.
 */

import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { callMCPTool } from '../protocols/mcp';
import { isAlwaysBlocked, isPrivateIp } from '../net';
import { isInternalProbesAllowed } from '../utils/probe-policy';
import { createPinAndBindFetch } from './pin-and-bind-fetch';
import type {
  PropertyListReference,
  CollectionListReference,
  GetPropertyListResponse,
  GetCollectionListResponse,
  Identifier,
} from '../types/tools.generated';

// ---------------------------------------------------------------------------
// Resolved list shapes
// ---------------------------------------------------------------------------

export interface ResolvedPropertyList {
  listId: string;
  agentUrl: string;
  identifiers: Identifier[];
  cacheValidUntil?: string;
}

/** A collection entry as returned by get_collection_list. */
export type ResolvedCollection = NonNullable<GetCollectionListResponse['collections']>[number];

export interface ResolvedCollectionList {
  listId: string;
  agentUrl: string;
  collections: ResolvedCollection[];
  cacheValidUntil?: string;
}

// ---------------------------------------------------------------------------
// Resolved list cache
// ---------------------------------------------------------------------------

export type ResolvedListKind = 'property' | 'collection';
export type ResolvedListCacheValue = ResolvedPropertyList | ResolvedCollectionList;
export const DEFAULT_RESOLVE_LIST_PAGE_SIZE = 1000;

export interface ResolvedListCacheEntry<TValue extends ResolvedListCacheValue = ResolvedListCacheValue> {
  value: TValue;
  expiresAtMs: number;
}

export interface ResolvedListCache {
  get<TValue extends ResolvedListCacheValue>(key: string, nowMs?: number): TValue | undefined;
  set<TValue extends ResolvedListCacheValue>(key: string, entry: ResolvedListCacheEntry<TValue>): void;
  delete(key: string): boolean;
  clear(): void;
}

class MemoryResolvedListCache implements ResolvedListCache {
  private readonly entries = new Map<string, ResolvedListCacheEntry>();

  get<TValue extends ResolvedListCacheValue>(key: string, nowMs = Date.now()): TValue | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= nowMs) {
      this.entries.delete(key);
      return undefined;
    }
    return cloneResolvedList(entry.value) as TValue;
  }

  set<TValue extends ResolvedListCacheValue>(key: string, entry: ResolvedListCacheEntry<TValue>): void {
    this.entries.set(key, {
      expiresAtMs: entry.expiresAtMs,
      value: cloneResolvedList(entry.value),
    });
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

export function createResolvedListCache(): ResolvedListCache {
  return new MemoryResolvedListCache();
}

export const defaultResolvedListCache = createResolvedListCache();

export function clearDefaultResolvedListCache(): void {
  defaultResolvedListCache.clear();
}

// ---------------------------------------------------------------------------
// resolvePropertyList / resolveCollectionList
// ---------------------------------------------------------------------------

export type ResolveListCallTool = (
  agentUrl: string,
  toolName: 'get_property_list' | 'get_collection_list',
  args: Record<string, unknown>,
  authToken?: string
) => Promise<unknown>;

const defaultResolveListFetchBase = createPinAndBindFetch();
const defaultResolveListFetch: typeof fetch = (input, init) =>
  defaultResolveListFetchBase(input, { ...init, redirect: 'manual' });

const defaultResolveListCallTool: ResolveListCallTool = (agentUrl, toolName, args, authToken) =>
  callMCPTool(agentUrl, toolName, args, authToken, [], undefined, undefined, defaultResolveListFetch);

export interface ResolveListOptions {
  /** Maximum page size when calling get_property_list / get_collection_list. Defaults to 1000. */
  pageSize?: number;
  /** Maximum number of pages to walk before treating pagination as unsafe. Defaults to 100. */
  maxPages?: number;
  /** Cache for resolved list contents. Defaults to the process-local SDK cache. Pass false to disable caching. */
  cache?: ResolvedListCache | false;
  /**
   * Tenant/principal/auth-context fingerprint for cache scoping when the list
   * reference does not carry an auth_token. Shared caching is disabled without
   * either auth_token or this explicit scope.
   */
  cacheScopeKey?: string;
  /** Clock hook for testing cache expiry. */
  now?: () => Date | number;
  /** MCP call hook for testing/custom transports. */
  callTool?: ResolveListCallTool;
}

/**
 * Resolve a PropertyListReference to the concrete identifiers it contains.
 *
 * Calls `get_property_list` on the referenced agent with `resolve: true`.
 * Honors `auth_token` on the reference if present.
 */
export async function resolvePropertyList(
  ref: PropertyListReference,
  options: ResolveListOptions = {}
): Promise<ResolvedPropertyList> {
  const structurallyNormalizedRef = await normalizePropertyListReference(ref, { resolveDns: false });
  const cache = cacheForOptions(options);
  const nowMs = nowMsForOptions(options);
  const cacheKey = resolvedListCacheKey('property', structurallyNormalizedRef, options);
  const cached = cacheKey ? cache?.get<ResolvedPropertyList>(cacheKey, nowMs) : undefined;
  if (cached) return cached;

  const normalizedRef = options.callTool
    ? structurallyNormalizedRef
    : await normalizePropertyListReference(structurallyNormalizedRef, { resolveDns: false });
  const result = await fetchResolvedPropertyList(normalizedRef, options);
  cacheResolvedList(cache, cacheKey, result, nowMs);
  return result;
}

async function fetchResolvedPropertyList(
  ref: PropertyListReference,
  options: ResolveListOptions
): Promise<ResolvedPropertyList> {
  const callTool = options.callTool ?? defaultResolveListCallTool;
  const identifiers: Identifier[] = [];
  let listId: string;
  let cacheValidUntil: string | undefined;
  let missingCacheValidUntil = false;
  let cursor: string | undefined;

  for (let pageIndex = 0; pageIndex < maxPagesForOptions(options); pageIndex += 1) {
    const args = buildResolveListArgs(ref.list_id, pageSizeForOptions(options), cursor);

    const raw = (await callTool(ref.agent_url, 'get_property_list', args, ref.auth_token)) as Record<string, unknown>;

    if (!raw || typeof raw !== 'object' || !('list' in raw)) {
      throw new Error('property_list_invalid_response');
    }
    const response = raw as unknown as GetPropertyListResponse;
    listId = response.list.list_id;
    identifiers.push(...(response.identifiers ?? []));
    if (typeof response.cache_valid_until === 'string') {
      cacheValidUntil = earliestIsoTimestamp(cacheValidUntil, response.cache_valid_until);
    } else {
      missingCacheValidUntil = true;
    }

    const pagination = readPagination(response.pagination);
    if (pagination.invalid) {
      throw new Error('property_list_invalid_pagination');
    }
    if (!pagination.hasMore) {
      return {
        listId,
        agentUrl: ref.agent_url,
        identifiers,
        cacheValidUntil: missingCacheValidUntil ? undefined : cacheValidUntil,
      };
    }
    if (!pagination.cursor) {
      throw new Error('property_list_invalid_pagination');
    }
    cursor = pagination.cursor;
  }

  throw new Error('property_list_pagination_limit_exceeded');
}

/**
 * Resolve a CollectionListReference to the concrete collections it contains.
 *
 * Calls `get_collection_list` on the referenced agent with `resolve: true`.
 * Honors `auth_token` on the reference if present.
 */
export async function resolveCollectionList(
  ref: CollectionListReference,
  options: ResolveListOptions = {}
): Promise<ResolvedCollectionList> {
  const structurallyNormalizedRef = await normalizeCollectionListReference(ref, { resolveDns: false });
  const cache = cacheForOptions(options);
  const nowMs = nowMsForOptions(options);
  const cacheKey = resolvedListCacheKey('collection', structurallyNormalizedRef, options);
  const cached = cacheKey ? cache?.get<ResolvedCollectionList>(cacheKey, nowMs) : undefined;
  if (cached) return cached;

  const normalizedRef = options.callTool
    ? structurallyNormalizedRef
    : await normalizeCollectionListReference(structurallyNormalizedRef, { resolveDns: false });
  const result = await fetchResolvedCollectionList(normalizedRef, options);
  cacheResolvedList(cache, cacheKey, result, nowMs);
  return result;
}

async function fetchResolvedCollectionList(
  ref: CollectionListReference,
  options: ResolveListOptions
): Promise<ResolvedCollectionList> {
  const callTool = options.callTool ?? defaultResolveListCallTool;
  const collections: ResolvedCollection[] = [];
  let listId: string;
  let cacheValidUntil: string | undefined;
  let missingCacheValidUntil = false;
  let cursor: string | undefined;

  for (let pageIndex = 0; pageIndex < maxPagesForOptions(options); pageIndex += 1) {
    const args = buildResolveListArgs(ref.list_id, pageSizeForOptions(options), cursor);

    const raw = (await callTool(ref.agent_url, 'get_collection_list', args, ref.auth_token)) as Record<string, unknown>;

    if (!raw || typeof raw !== 'object' || !('list' in raw)) {
      throw new Error('collection_list_invalid_response');
    }
    const response = raw as unknown as GetCollectionListResponse;
    listId = response.list.list_id;
    collections.push(...(response.collections ?? []));
    if (typeof response.cache_valid_until === 'string') {
      cacheValidUntil = earliestIsoTimestamp(cacheValidUntil, response.cache_valid_until);
    } else {
      missingCacheValidUntil = true;
    }

    const pagination = readPagination(response.pagination);
    if (pagination.invalid) {
      throw new Error('collection_list_invalid_pagination');
    }
    if (!pagination.hasMore) {
      return {
        listId,
        agentUrl: ref.agent_url,
        collections,
        cacheValidUntil: missingCacheValidUntil ? undefined : cacheValidUntil,
      };
    }
    if (!pagination.cursor) {
      throw new Error('collection_list_invalid_pagination');
    }
    cursor = pagination.cursor;
  }

  throw new Error('collection_list_pagination_limit_exceeded');
}

export function resolvedListCacheKey(
  kind: ResolvedListKind,
  ref: Pick<PropertyListReference | CollectionListReference, 'agent_url' | 'list_id' | 'auth_token'>,
  options: Pick<ResolveListOptions, 'pageSize' | 'cacheScopeKey'> = {}
): string | undefined {
  const scope = ref.auth_token ?? options.cacheScopeKey;
  if (!scope) return undefined;
  const material = JSON.stringify({
    kind,
    agent_url: ref.agent_url,
    list_id: ref.list_id,
    scope_sha256: sha256(scope),
    page_size: options.pageSize ?? DEFAULT_RESOLVE_LIST_PAGE_SIZE,
    resolve: true,
  });
  return `adcp-resolved-list:${sha256(material)}`;
}

async function normalizePropertyListReference(
  ref: PropertyListReference,
  options: { resolveDns: boolean }
): Promise<PropertyListReference> {
  return {
    ...ref,
    agent_url: await normalizeListAgentUrl(ref.agent_url, options),
  };
}

async function normalizeCollectionListReference(
  ref: CollectionListReference,
  options: { resolveDns: boolean }
): Promise<CollectionListReference> {
  return {
    ...ref,
    agent_url: await normalizeListAgentUrl(ref.agent_url, options),
  };
}

async function normalizeListAgentUrl(raw: string, options: { resolveDns: boolean }): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('list_agent_url_invalid');
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error('list_agent_url_malformed');
  }

  const allowInternal = isInternalProbesAllowed();
  if (url.protocol !== 'https:' && !(allowInternal && url.protocol === 'http:')) {
    throw new Error('list_agent_url_insecure');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isAlwaysBlocked(hostname)) {
    throw new Error('list_agent_url_always_blocked');
  }
  if (!allowInternal && isPrivateIp(hostname)) {
    throw new Error('list_agent_url_private_address');
  }

  if (options.resolveDns) {
    let addresses: { address: string }[];
    try {
      addresses = await dnsLookup(hostname, { all: true });
    } catch {
      throw new Error('list_agent_url_dns_failed');
    }
    if (addresses.length === 0) {
      throw new Error('list_agent_url_dns_empty');
    }
    for (const { address } of addresses) {
      if (isAlwaysBlocked(address)) {
        throw new Error('list_agent_url_always_blocked');
      }
      if (!allowInternal && isPrivateIp(address)) {
        throw new Error('list_agent_url_private_address');
      }
    }
  }

  return url.toString();
}

function buildResolveListArgs(listId: string, pageSize: number, cursor: string | undefined) {
  const args: Record<string, unknown> = {
    list_id: listId,
    resolve: true,
  };
  const pagination: Record<string, unknown> = {};
  pagination.max_results = pageSize;
  if (cursor) pagination.cursor = cursor;
  if (Object.keys(pagination).length > 0) args.pagination = pagination;
  return args;
}

function cacheForOptions(options: ResolveListOptions): ResolvedListCache | undefined {
  if (options.callTool && options.cache === undefined) return undefined;
  return options.cache === false ? undefined : (options.cache ?? defaultResolvedListCache);
}

function cacheResolvedList(
  cache: ResolvedListCache | undefined,
  cacheKey: string | undefined,
  value: ResolvedListCacheValue,
  nowMs: number
): void {
  if (!cache || !cacheKey || !value.cacheValidUntil) return;
  const expiresAtMs = Date.parse(value.cacheValidUntil);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return;
  cache.set(cacheKey, { value, expiresAtMs });
}

function nowMsForOptions(options: ResolveListOptions): number {
  const now = options.now?.();
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  return Date.now();
}

function maxPagesForOptions(options: ResolveListOptions): number {
  return options.maxPages ?? 100;
}

function pageSizeForOptions(options: Pick<ResolveListOptions, 'pageSize'>): number {
  return options.pageSize ?? DEFAULT_RESOLVE_LIST_PAGE_SIZE;
}

function readPagination(value: unknown): { hasMore: boolean; cursor?: string; invalid: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { hasMore: false, invalid: false };
  const pagination = value as { has_more?: unknown; cursor?: unknown };
  const cursor = typeof pagination.cursor === 'string' && pagination.cursor.length > 0 ? pagination.cursor : undefined;
  const invalid =
    (pagination.has_more !== undefined && typeof pagination.has_more !== 'boolean') ||
    (cursor !== undefined && pagination.has_more !== true);
  return {
    hasMore: pagination.has_more === true,
    cursor,
    invalid,
  };
}

function earliestIsoTimestamp(current: string | undefined, next: string): string {
  if (!current) return next;
  const currentMs = Date.parse(current);
  const nextMs = Date.parse(next);
  if (!Number.isFinite(currentMs)) return next;
  if (!Number.isFinite(nextMs)) return current;
  return nextMs < currentMs ? next : current;
}

function cloneResolvedList<TValue extends ResolvedListCacheValue>(value: TValue): TValue {
  return structuredClone(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// matchesPropertyList / matchesCollectionList
// ---------------------------------------------------------------------------

/**
 * Return true if `property` matches any identifier in the resolved list.
 *
 * Domain matching rules (from the AdCP property spec):
 * - Exact match on the identifier value is always accepted.
 * - A `domain` entry of `example.com` also matches `www.example.com` and
 *   `m.example.com` — the two canonical aliases for a base domain.
 * - A `domain` entry of `*.example.com` matches every subdomain but NOT the
 *   base domain itself.
 * - Non-domain identifier types (ios_bundle, network_id, etc.) use exact
 *   string match on both `type` and `value`.
 */
export function matchesPropertyList(property: Identifier, list: ResolvedPropertyList): boolean {
  return list.identifiers.some(entry => identifiersMatch(property, entry));
}

function identifiersMatch(property: Identifier, entry: Identifier): boolean {
  if (property.type !== entry.type) return false;
  if (property.type !== 'domain') {
    return property.value === entry.value;
  }
  return domainMatches(property.value, entry.value);
}

function domainMatches(candidate: string, pattern: string): boolean {
  const c = candidate.toLowerCase();
  const p = pattern.toLowerCase();
  if (c === p) return true;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // ".example.com"
    return c.endsWith(suffix) && c !== p.slice(2);
  }
  return c === `www.${p}` || c === `m.${p}`;
}

/**
 * Return true if `collection` matches any entry in the resolved list.
 *
 * Matching modes:
 * - Collections match when `collection_rid` is set on both sides and equal.
 * - Otherwise, they match when they share at least one `distribution_ids`
 *   entry with the same `type` and `value`.
 *
 * A collection with no collection_rid and no distribution_ids cannot match —
 * the seller has nothing to match against.
 */
export function matchesCollectionList(
  collection: { collection_rid?: string; distribution_ids?: { type: string; value: string }[] },
  list: ResolvedCollectionList
): boolean {
  return list.collections.some(entry => collectionsMatch(collection, entry));
}

function collectionsMatch(
  a: { collection_rid?: string; distribution_ids?: { type: string; value: string }[] },
  b: ResolvedCollection
): boolean {
  if (a.collection_rid && b.collection_rid && a.collection_rid === b.collection_rid) {
    return true;
  }
  if (!a.distribution_ids?.length || !b.distribution_ids?.length) return false;
  return a.distribution_ids.some(aid =>
    b.distribution_ids!.some(bid => aid.type === bid.type && aid.value === bid.value)
  );
}
