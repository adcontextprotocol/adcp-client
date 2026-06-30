/**
 * Inline-resolution path for `publisher_properties` selectors per
 * [adcontextprotocol/adcp#4825](https://github.com/adcontextprotocol/adcp/issues/4825)
 * (spec PR [adcp#4827](https://github.com/adcontextprotocol/adcp/pull/4827)).
 *
 * The pattern: when a parent `adagents.json`'s top-level `properties[]`
 * carry `publisher_domain` entries that match the selector's target domain,
 * the consumer MAY satisfy the selector inline — without per-child federated
 * `adagents.json` fetches. The federated path stays correct (the spec
 * requires consumers that resolve federated to keep doing so), but small
 * managed-network adopters who centralize their property catalog on the
 * parent file can skip an N-domain fanout of HTTP fetches.
 *
 * Resolution rules:
 *  - Match parent's `properties[]` by `publisher_domain` (case-insensitive).
 *  - Apply the selector's predicate (`'all'` / `'by_id'` / `'by_tag'`) to
 *    the matched subset.
 *  - Honor `revoked_publisher_domains[]` on the parent file: a selector
 *    targeting a revoked domain resolves to **zero properties** AND signals
 *    that no federated fallback should fire for that domain.
 *  - Divergence rule (per spec): when both inline and federated resolve and
 *    disagree on `(publisher_domain, property_id)`, federated wins; SDK
 *    SHOULD log. See {@link detectInlineFederatedDivergence}.
 *
 * @public
 */

import type { AdAgentsJson, Property, PublisherPropertySelector, SinglePublisherPropertySelector } from './types';
import { expandPublisherPropertySelector } from './publisher-property-selector';

/**
 * Outcome of inline-resolving a single (singular-form) selector against the
 * parent file's `properties[]`.
 */
export interface InlineResolutionResult {
  /**
   * Properties matched inline. Empty when no parent entries had matching
   * `publisher_domain` OR when the domain is in `revoked_publisher_domains[]`.
   */
  properties: Property[];
  /**
   * Why inline resolution did not produce matches. Revocation is handled by
   * {@link resolveInlinePublisherProperties} (which short-circuits before
   * invoking this helper); per-selector callers using
   * {@link resolveSingularInline} directly must consult
   * `adAgents.revoked_publisher_domains[]` themselves before calling.
   */
  reason: 'matched' | 'domain_not_inline' | 'no_predicate_match';
}

/**
 * Inline-resolve every selector in a publisher_properties array against the
 * parent file's `properties[]`. Compact-form selectors are fanned out before
 * resolution.
 *
 * Returns:
 *  - `inline_properties`: every property matched inline across all selectors
 *    (de-duplicated by `property_id` when present, by reference identity
 *    otherwise).
 *  - `unresolved_selectors`: singular selectors that still need federated
 *    resolution (inline produced no match AND domain is not revoked).
 *  - `revoked_selectors`: singular selectors that were dropped because the
 *    parent file lists their domain in `revoked_publisher_domains[]`.
 *    Federated fallback MUST NOT fire for these.
 *
 * Witness, not translator: the function does not invent properties or
 * mutate the input. Counterparty-controlled fields (`publisher_domain`,
 * `tags`, `property_id`) are read defensively.
 */
export function resolveInlinePublisherProperties(
  adAgents: AdAgentsJson,
  selectors: ReadonlyArray<PublisherPropertySelector>
): {
  inline_properties: Property[];
  unresolved_selectors: SinglePublisherPropertySelector[];
  revoked_selectors: SinglePublisherPropertySelector[];
} {
  const parentProperties = Array.isArray(adAgents.properties) ? adAgents.properties : [];
  const revokedDomains = revokedDomainSet(adAgents.revoked_publisher_domains);

  const inline: Property[] = [];
  const unresolved: SinglePublisherPropertySelector[] = [];
  const revoked: SinglePublisherPropertySelector[] = [];
  const seenPropertyIds = new Set<string>();
  const seenRefs = new Set<Property>();

  for (const raw of selectors) {
    for (const sel of expandPublisherPropertySelector(raw)) {
      const domain = sel.publisher_domain.toLowerCase();
      if (revokedDomains.has(domain)) {
        revoked.push(sel);
        continue;
      }
      const result = resolveSingularInline(parentProperties, sel);
      if (result.reason === 'matched') {
        for (const p of result.properties) {
          if (p.property_id !== undefined) {
            if (seenPropertyIds.has(p.property_id)) continue;
            seenPropertyIds.add(p.property_id);
          } else if (seenRefs.has(p)) {
            continue;
          } else {
            seenRefs.add(p);
          }
          inline.push(p);
        }
      } else {
        // domain_not_inline OR no_predicate_match → federated may fall through
        unresolved.push(sel);
      }
    }
  }

  return { inline_properties: inline, unresolved_selectors: unresolved, revoked_selectors: revoked };
}

/**
 * Inline-resolve a single (singular-form) selector against a parent
 * `properties[]` list. Exported for adopters that want fine-grained control
 * over per-selector behavior (e.g., a custom federated fallback policy).
 */
export function resolveSingularInline(
  parentProperties: ReadonlyArray<Property>,
  selector: SinglePublisherPropertySelector
): InlineResolutionResult {
  const wantedDomain = selector.publisher_domain.toLowerCase();
  const domainMatches = parentProperties.filter(p => {
    const d = p.publisher_domain;
    return typeof d === 'string' && d.toLowerCase() === wantedDomain;
  });
  if (domainMatches.length === 0) {
    return { properties: [], reason: 'domain_not_inline' };
  }

  switch (selector.selection_type) {
    case 'all':
      return { properties: domainMatches, reason: 'matched' };
    case 'by_id': {
      const idSet = new Set(selector.property_ids);
      const matched = domainMatches.filter(p => p.property_id !== undefined && idSet.has(p.property_id));
      return matched.length > 0
        ? { properties: matched, reason: 'matched' }
        : { properties: [], reason: 'no_predicate_match' };
    }
    case 'by_tag': {
      const tagSet = new Set(selector.property_tags);
      const matched = domainMatches.filter(p => Array.isArray(p.tags) && p.tags.some(t => tagSet.has(t)));
      return matched.length > 0
        ? { properties: matched, reason: 'matched' }
        : { properties: [], reason: 'no_predicate_match' };
    }
  }
}

/**
 * Divergence report for a single `(publisher_domain, property_id)` pair
 * that resolved differently inline vs federated. Per the spec, federated
 * wins; the report exists for the SDK / adopter to log.
 */
export interface InlineFederatedDivergence {
  publisher_domain: string;
  property_id: string;
  inline_property: Property;
  federated_property: Property;
  /** Field paths whose values differ (e.g. `['name', 'tags', 'identifiers']`). */
  differing_fields: string[];
}

/**
 * Compare inline-resolved properties against federated-resolved properties
 * for the same `(publisher_domain, property_id)` pairs and report divergence.
 * Properties without a `property_id` are not comparable across paths and are
 * skipped here.
 *
 * Per [adcp#4825](https://github.com/adcontextprotocol/adcp/issues/4825):
 * "When both paths resolve to the same `(publisher_domain, property_id)`
 * and disagree, federated wins; SDK SHOULD log the divergence." This
 * function produces the divergence; the caller decides how to log.
 *
 * Field comparison is shallow JSON-equality on the spec-defined fields
 * (`property_type`, `name`, `identifiers`, `tags`, `publisher_domain`).
 * Vendor-extension fields (`[k: string]: unknown`) are not compared.
 */
export function detectInlineFederatedDivergence(
  inline: ReadonlyArray<Property>,
  federated: ReadonlyArray<Property>
): InlineFederatedDivergence[] {
  const inlineByKey = indexPropertiesByDomainAndId(inline);
  const out: InlineFederatedDivergence[] = [];
  for (const fed of federated) {
    if (typeof fed.property_id !== 'string' || typeof fed.publisher_domain !== 'string') continue;
    const key = `${fed.publisher_domain.toLowerCase()}|${fed.property_id}`;
    const ours = inlineByKey.get(key);
    if (!ours) continue;
    const differing = compareSpecFields(ours, fed);
    if (differing.length > 0) {
      out.push({
        publisher_domain: fed.publisher_domain.toLowerCase(),
        property_id: fed.property_id,
        inline_property: ours,
        federated_property: fed,
        differing_fields: differing,
      });
    }
  }
  return out;
}

function indexPropertiesByDomainAndId(properties: ReadonlyArray<Property>): Map<string, Property> {
  const out = new Map<string, Property>();
  for (const p of properties) {
    if (typeof p.property_id !== 'string' || typeof p.publisher_domain !== 'string') continue;
    out.set(`${p.publisher_domain.toLowerCase()}|${p.property_id}`, p);
  }
  return out;
}

function compareSpecFields(a: Property, b: Property): string[] {
  const fields: Array<keyof Property> = ['property_type', 'name', 'identifiers', 'tags', 'publisher_domain'];
  const out: string[] = [];
  for (const f of fields) {
    if (!shallowEqual(a[f], b[f])) out.push(String(f));
  }
  return out;
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => shallowEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    // Key-order-stable comparison — `JSON.stringify` reflects insertion order,
    // and inline objects vs federated-parsed objects can differ on order
    // (`{type, value}` vs `{value, type}` for PropertyIdentifier). Producing
    // false-positive divergences would make the SHOULD-log channel flap.
    const ka = Object.keys(a as Record<string, unknown>).sort();
    const kb = Object.keys(b as Record<string, unknown>).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every(k => shallowEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

function revokedDomainSet(input: unknown): Set<string> {
  if (!Array.isArray(input)) return new Set();
  const out = new Set<string>();
  for (const item of input) {
    const domain =
      typeof item === 'string'
        ? item
        : item &&
            typeof item === 'object' &&
            typeof (item as { publisher_domain?: unknown }).publisher_domain === 'string'
          ? (item as { publisher_domain: string }).publisher_domain
          : undefined;
    if (domain && domain.length > 0) out.add(domain.toLowerCase());
  }
  return out;
}
