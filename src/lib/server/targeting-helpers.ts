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
 * import { resolvePropertyList, matchesPropertyList } from '@adcp/client/server';
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

import { callMCPTool } from '../protocols/mcp';
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
// resolvePropertyList / resolveCollectionList
// ---------------------------------------------------------------------------

export interface ResolveListOptions {
  /** Maximum page size when calling get_property_list / get_collection_list. Defaults to 1000. */
  pageSize?: number;
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
  const args: Record<string, unknown> = {
    list_id: ref.list_id,
    resolve: true,
  };
  if (options.pageSize != null) args.page_size = options.pageSize;

  const raw = (await callMCPTool(ref.agent_url, 'get_property_list', args, ref.auth_token)) as Record<string, unknown>;

  if (!raw || typeof raw !== 'object' || !('list' in raw)) {
    throw new Error(
      `Invalid get_property_list response from ${ref.agent_url}: missing 'list'. ` +
        `Got: ${JSON.stringify(raw)?.slice(0, 200)}`
    );
  }
  const response = raw as unknown as GetPropertyListResponse;

  return {
    listId: response.list.list_id,
    agentUrl: ref.agent_url,
    identifiers: response.identifiers ?? [],
    cacheValidUntil: response.cache_valid_until ?? undefined,
  };
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
  const args: Record<string, unknown> = {
    list_id: ref.list_id,
    resolve: true,
  };
  if (options.pageSize != null) args.page_size = options.pageSize;

  const raw = (await callMCPTool(ref.agent_url, 'get_collection_list', args, ref.auth_token)) as Record<
    string,
    unknown
  >;

  if (!raw || typeof raw !== 'object' || !('list' in raw)) {
    throw new Error(
      `Invalid get_collection_list response from ${ref.agent_url}: missing 'list'. ` +
        `Got: ${JSON.stringify(raw)?.slice(0, 200)}`
    );
  }
  const response = raw as unknown as GetCollectionListResponse;

  return {
    listId: response.list.list_id,
    agentUrl: ref.agent_url,
    collections: response.collections ?? [],
    cacheValidUntil: response.cache_valid_until ?? undefined,
  };
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
