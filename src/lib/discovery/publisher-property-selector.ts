/**
 * Parser, validator, and fan-out helpers for `publisher-property-selector.json`
 * including the compact `publisher_domains[]` form introduced in
 * [adcontextprotocol/adcp#4504](https://github.com/adcontextprotocol/adcp/pull/4504)
 * (adcp-client#1737).
 *
 * A selector is either:
 *  - **Singular** — `{ publisher_domain: string, selection_type, ...predicate }`
 *  - **Compact** — `{ publisher_domains: string[], selection_type, ...predicate }`
 *    Logically equivalent to repeating the singular form once per listed
 *    domain. Only valid for `selection_type: 'all' | 'by_tag'` — `'by_id'`
 *    is single-publisher only since property IDs are publisher-scoped.
 *
 * XOR — both-present or neither-present fails validation.
 *
 * Most call sites that index by publisher want to consume the post-fan-out
 * shape, not the raw wire shape — use {@link expandPublisherPropertySelectors}
 * to flatten a `PublisherPropertySelector[]` into N singular selectors before
 * iterating.
 */
import type {
  PublisherPropertySelector,
  SinglePublisherPropertySelector,
  CompactPublisherPropertySelector,
} from './types';

/** Why a raw selector failed `parsePublisherPropertySelector` validation. */
export type PublisherPropertySelectorError =
  | 'not_an_object'
  | 'missing_selection_type'
  | 'unknown_selection_type'
  | 'missing_publisher_domain'
  | 'both_publisher_domain_and_domains'
  | 'compact_form_not_allowed_for_by_id'
  | 'publisher_domains_empty'
  | 'publisher_domains_not_string_array'
  | 'publisher_domains_too_many'
  | 'publisher_domain_not_lowercase'
  | 'publisher_domains_duplicate_entry'
  | 'publisher_domain_contains_invalid_chars'
  | 'missing_property_ids'
  | 'missing_property_tags';

/**
 * Per-selector cap on `publisher_domains[]` length. Bounds post-parse
 * allocation against a malicious publisher shipping a billion-domain
 * fanout that would survive the body-byte cap. Raptive's live file ships
 * 6,800 entries; 50,000 gives ~7× headroom for the largest legitimate
 * networks. Exported so adopters with stricter SLOs can clamp lower
 * before parsing.
 */
export const MAX_PUBLISHER_DOMAINS_PER_SELECTOR = 50_000;

export class PublisherPropertySelectorParseError extends Error {
  constructor(
    public readonly code: PublisherPropertySelectorError,
    message: string
  ) {
    super(message);
    this.name = 'PublisherPropertySelectorParseError';
  }
}

/**
 * Parse + validate a raw selector value (e.g. from `adagents.json`). Throws
 * {@link PublisherPropertySelectorParseError} on schema violations. Returns
 * the input cast to a typed `PublisherPropertySelector` on success — does
 * NOT fan compact-form selectors out (use
 * {@link expandPublisherPropertySelector} for that).
 *
 * Enforces every rule a vanilla Ajv validation of `publisher-property-selector.json`
 * would (XOR between `publisher_domain` / `publisher_domains`, `by_id`
 * exclusion from the compact form, required predicate fields per
 * `selection_type`) so callers that don't run a JSON Schema validator still
 * get the same fail-closed behavior.
 */
export function parsePublisherPropertySelector(raw: unknown): PublisherPropertySelector {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PublisherPropertySelectorParseError('not_an_object', 'selector must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const selType = obj.selection_type;
  if (typeof selType !== 'string') {
    throw new PublisherPropertySelectorParseError('missing_selection_type', 'selection_type is required');
  }
  if (selType !== 'all' && selType !== 'by_id' && selType !== 'by_tag') {
    throw new PublisherPropertySelectorParseError('unknown_selection_type', `unknown selection_type: ${selType}`);
  }

  const hasDomain = typeof obj.publisher_domain === 'string';
  const hasDomains = obj.publisher_domains !== undefined;

  if (hasDomain && hasDomains) {
    throw new PublisherPropertySelectorParseError(
      'both_publisher_domain_and_domains',
      'publisher_domain and publisher_domains are mutually exclusive'
    );
  }
  if (!hasDomain && !hasDomains) {
    throw new PublisherPropertySelectorParseError(
      'missing_publisher_domain',
      'exactly one of publisher_domain or publisher_domains must be present'
    );
  }
  if (hasDomain) {
    assertDomainStringValid(obj.publisher_domain as string);
    assertDomainLowercase(obj.publisher_domain as string);
  }
  if (hasDomains) {
    if (selType === 'by_id') {
      throw new PublisherPropertySelectorParseError(
        'compact_form_not_allowed_for_by_id',
        'publisher_domains is not allowed for selection_type: by_id — property IDs are publisher-scoped'
      );
    }
    if (!Array.isArray(obj.publisher_domains) || obj.publisher_domains.some(d => typeof d !== 'string')) {
      throw new PublisherPropertySelectorParseError(
        'publisher_domains_not_string_array',
        'publisher_domains must be an array of strings'
      );
    }
    if (obj.publisher_domains.length === 0) {
      throw new PublisherPropertySelectorParseError(
        'publisher_domains_empty',
        'publisher_domains must contain at least one entry'
      );
    }
    if (obj.publisher_domains.length > MAX_PUBLISHER_DOMAINS_PER_SELECTOR) {
      throw new PublisherPropertySelectorParseError(
        'publisher_domains_too_many',
        `publisher_domains length ${obj.publisher_domains.length} exceeds cap ${MAX_PUBLISHER_DOMAINS_PER_SELECTOR}`
      );
    }
    const seen = new Set<string>();
    for (const d of obj.publisher_domains as string[]) {
      assertDomainStringValid(d);
      assertDomainLowercase(d);
      if (seen.has(d)) {
        throw new PublisherPropertySelectorParseError(
          'publisher_domains_duplicate_entry',
          `publisher_domains contains duplicate entry: ${truncateForError(d)}`
        );
      }
      seen.add(d);
    }
  }

  if (selType === 'by_id') {
    if (!Array.isArray(obj.property_ids) || obj.property_ids.length === 0) {
      throw new PublisherPropertySelectorParseError(
        'missing_property_ids',
        'property_ids is required for selection_type: by_id'
      );
    }
  }
  if (selType === 'by_tag') {
    if (!Array.isArray(obj.property_tags) || obj.property_tags.length === 0) {
      throw new PublisherPropertySelectorParseError(
        'missing_property_tags',
        'property_tags is required for selection_type: by_tag'
      );
    }
  }

  return raw as PublisherPropertySelector;
}

/**
 * Type guard — true if the selector uses the compact `publisher_domains[]`
 * form AND that field is a non-empty array of strings. Counterparty input
 * that ships `publisher_domains: "evil"` (string) or `null` reports false
 * here, so {@link expandPublisherPropertySelector} routes it down the
 * singular path (which itself fails closed on missing `publisher_domain`).
 * Witness, not translator — malformed selectors are not silently coerced
 * into either branch.
 */
export function isCompactPublisherPropertySelector(
  selector: PublisherPropertySelector
): selector is CompactPublisherPropertySelector {
  const domains = (selector as { publisher_domains?: unknown }).publisher_domains;
  return Array.isArray(domains) && domains.length > 0 && domains.every(d => typeof d === 'string');
}

/**
 * Fan a compact-form selector out to its singular equivalents. Singular
 * selectors pass through as a single-element array. Use this at every call
 * site that indexes selectors by `publisher_domain` — without it, compact
 * entries silently disappear from per-publisher indices.
 *
 * **Counterparty-controlled input.** Validates that compact entries are
 * lowercase, unique, and free of control characters; non-conforming
 * compact selectors return `[]` rather than silently coerce. Adopters
 * who need explicit error reporting should run
 * {@link parsePublisherPropertySelector} first — this fanout is the
 * indexing helper, not the validator.
 */
export function expandPublisherPropertySelector(
  selector: PublisherPropertySelector
): SinglePublisherPropertySelector[] {
  if (!isCompactPublisherPropertySelector(selector)) {
    // Singular form. We still gate on a valid `publisher_domain` string —
    // fail closed if the counterparty shipped a missing/malformed field
    // rather than emit a singular selector with `publisher_domain:
    // undefined` that would taint downstream indices.
    const single = selector as { publisher_domain?: unknown };
    if (typeof single.publisher_domain !== 'string' || !isDomainStringValid(single.publisher_domain)) {
      return [];
    }
    return [selector];
  }
  // De-dupe + filter unsafe characters defensively. The spec's schema
  // pattern rejects uppercase / control chars, but this code runs ahead
  // of any Ajv pass in `resolveAgentProperties` and friends, so we keep
  // the dedupe-by-lowercase + invalid-char drop here as a fail-closed
  // backstop. Callers that need strict reporting should route through
  // `parsePublisherPropertySelector` first.
  const seen = new Set<string>();
  const domains: string[] = [];
  for (const d of selector.publisher_domains) {
    if (!isDomainStringValid(d)) continue;
    const lower = d.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    domains.push(lower);
  }

  if (selector.selection_type === 'all') {
    return domains.map(publisher_domain => ({ selection_type: 'all', publisher_domain }));
  }
  return domains.map(publisher_domain => ({
    selection_type: 'by_tag',
    publisher_domain,
    property_tags: selector.property_tags,
  }));
}

/**
 * Fan an array of selectors out to their singular equivalents. Compact-form
 * entries expand into N singular selectors; singular entries pass through.
 * The output order preserves input order, then per-selector domain order.
 */
export function expandPublisherPropertySelectors(
  selectors: ReadonlyArray<PublisherPropertySelector>
): SinglePublisherPropertySelector[] {
  return selectors.flatMap(expandPublisherPropertySelector);
}

/**
 * Lowercased set of every publisher domain a selector array addresses,
 * across both singular and compact forms. Useful for explicit-scoping
 * checks (e.g., `managerdomain` fallback safety).
 */
export function publisherDomainsCoveredBySelectors(selectors: ReadonlyArray<PublisherPropertySelector>): Set<string> {
  const out = new Set<string>();
  for (const sel of selectors) {
    if (isCompactPublisherPropertySelector(sel)) {
      for (const d of sel.publisher_domains) {
        if (isDomainStringValid(d)) out.add(d.toLowerCase());
      }
    } else {
      const single = sel as { publisher_domain?: unknown };
      if (typeof single.publisher_domain === 'string' && isDomainStringValid(single.publisher_domain)) {
        out.add(single.publisher_domain.toLowerCase());
      }
    }
  }
  return out;
}

/**
 * Whether a string is safe to use as a publisher domain in indices and
 * log lines. The schema's domain pattern already rejects most of what we
 * check here; this is the runtime guard used by code paths that don't
 * route through Ajv. Counterparty input including control characters
 * (`\x00`-`\x1f`, `\x7f`), whitespace, or selectors longer than 253
 * octets (RFC 1035 hostname cap) is dropped — fail-closed, not
 * normalized — so a malicious publisher cannot inject log-line breaks
 * or pseudo-paths via a domain string. Exported for adopters that want
 * to mirror the same guard ahead of their own indexing.
 */
export function isDomainStringValid(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 253) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\x00-\x1f\x7f\s]/.test(value);
}

function assertDomainStringValid(value: string): void {
  if (!isDomainStringValid(value)) {
    throw new PublisherPropertySelectorParseError(
      'publisher_domain_contains_invalid_chars',
      `publisher domain contains invalid characters or is too long: ${truncateForError(value)}`
    );
  }
}

function assertDomainLowercase(value: string): void {
  if (value !== value.toLowerCase()) {
    throw new PublisherPropertySelectorParseError(
      'publisher_domain_not_lowercase',
      `publisher domain must be lowercase per the AdCP schema pattern: ${truncateForError(value)}`
    );
  }
}

/**
 * Cap publisher-supplied strings before they land in error messages to
 * prevent a malicious publisher from blowing up adopter log lines via a
 * megabyte-long domain.
 */
function truncateForError(value: string): string {
  const MAX = 80;
  return value.length > MAX ? `${value.slice(0, MAX)}…` : value;
}
