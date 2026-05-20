/**
 * Property Discovery Types
 * Aligned with the AdCP `adagents.json` schema at
 * `schemas/cache/3.0.11/adagents.json`.
 */

/** Property identifier types from AdCP spec */
export type PropertyIdentifierType =
  | 'domain'
  | 'subdomain'
  | 'ios_bundle'
  | 'android_package'
  | 'apple_app_store_id'
  | 'google_play_id'
  | 'amazon_app_store_id'
  | 'roku_channel_id'
  | 'samsung_app_id'
  | 'lg_channel_id'
  | 'vizio_app_id'
  | 'fire_tv_app_id'
  | 'dooh_venue_id'
  | 'podcast_rss_feed'
  | 'spotify_show_id'
  | 'apple_podcast_id'
  | 'iab_tech_lab_domain_id'
  | 'custom';

/** Property identifier */
export interface PropertyIdentifier {
  type: PropertyIdentifierType;
  value: string;
}

/** Property types */
export type PropertyType = 'website' | 'mobile_app' | 'ctv_app' | 'dooh' | 'podcast' | 'radio' | 'streaming_audio';

/** Advertising property definition from adagents.json */
export interface Property {
  property_id?: string;
  property_type: PropertyType;
  name: string;
  identifiers: PropertyIdentifier[];
  tags?: string[];
  publisher_domain?: string;
}

/**
 * Discriminator for the per-agent authorization scope on each
 * `authorized_agents[]` entry. Drives `resolveAgentProperties()` —
 * see `src/lib/discovery/resolve-agent-properties.ts`.
 */
export type AuthorizationType =
  | 'property_ids'
  | 'property_tags'
  | 'inline_properties'
  | 'publisher_properties'
  | 'signal_ids'
  | 'signal_tags';

/**
 * Cross-publisher selector used by `authorization_type: 'publisher_properties'`.
 * Each entry references properties from a different publisher's adagents.json
 * (resolving the actual `Property` objects requires fetching that publisher's
 * file separately).
 *
 * Two shapes per the spec:
 *
 *  - **Singular** — `publisher_domain: string`. One selector targets one
 *    publisher. Available for all `selection_type` variants.
 *  - **Compact / fan-out** — `publisher_domains: string[]`. One selector
 *    targets every listed publisher with the same predicate. The compact
 *    form is **only** available for `selection_type: 'all' | 'by_tag'`.
 *    `'by_id'` is single-publisher only — property IDs are scoped to one
 *    publisher's adagents.json, so the fan-out semantics don't make sense.
 *    See adcontextprotocol/adcp#4504.
 *
 * The two shapes are XOR — both-present or neither-present fails validation.
 * Callers that iterate by `publisher_domain` MUST first fan compact-form
 * selectors out to singular via {@link expandPublisherPropertySelectors}
 * (`src/lib/discovery/publisher-property-selector.ts`), otherwise they will
 * silently miss the publishers carried in `publisher_domains[]`.
 */
export type PublisherPropertySelector = SinglePublisherPropertySelector | CompactPublisherPropertySelector;

/** Singular form — one selector, one publisher. Post-fanout shape. */
export type SinglePublisherPropertySelector =
  | { selection_type: 'all'; publisher_domain: string }
  | { selection_type: 'by_id'; publisher_domain: string; property_ids: string[] }
  | { selection_type: 'by_tag'; publisher_domain: string; property_tags: string[] };

/**
 * Compact form — one selector, N publishers, same predicate.
 * `by_id` is intentionally excluded (property IDs are publisher-scoped).
 */
export type CompactPublisherPropertySelector =
  | { selection_type: 'all'; publisher_domains: string[] }
  | { selection_type: 'by_tag'; publisher_domains: string[]; property_tags: string[] };

/**
 * Entry in `adagents.json` `authorized_agents[]`. The schema requires
 * every entry to carry `authorization_type` plus the matching selector
 * field — see the spec at `schemas/cache/3.0.11/adagents.json`. Files
 * in the wild sometimes omit them, so both fields are typed as optional
 * here. `resolveAgentProperties()` fails closed (returns no properties)
 * when the discriminator or its selector is missing.
 */
export interface AuthorizedAgent {
  url: string;
  authorized_for: string;
  /** Discriminator. Required by the schema; absent in pre-schema-3 files. */
  authorization_type?: AuthorizationType;
  /** Selector for `authorization_type: 'property_ids'`. */
  property_ids?: string[];
  /** Selector for `authorization_type: 'property_tags'`. */
  property_tags?: string[];
  /** Selector for `authorization_type: 'inline_properties'`. */
  properties?: Property[];
  /** Selector for `authorization_type: 'publisher_properties'`. */
  publisher_properties?: PublisherPropertySelector[];
  /** Selector for `authorization_type: 'signal_ids'` (signals agents). */
  signal_ids?: string[];
  /** Selector for `authorization_type: 'signal_tags'` (signals agents). */
  signal_tags?: string[];
}

/**
 * Per-publisher format declaration inside `adagents.json#/formats`.
 * Added in AdCP 3.1 (PR adcontextprotocol/adcp#3307 → spec PR
 * #4620). Lets publishers publish their accepted creative formats
 * directly at their domain, scoped to specific properties via
 * `applies_to_property_ids` / `applies_to_property_tags`.
 *
 * Shape mirrors the v2 `ProductFormatDeclaration` (canonical
 * `format_kind` + `params` + optional `capability_id` for inline
 * placement references) — kept loose at this layer because the
 * discovery types don't depend on the v2/canonical-formats stack.
 * `src/lib/v2/publisher-catalog/` consumes this with stronger
 * typing.
 *
 * Always optional on AdAgentsJson — fully backwards-compatible. A
 * 3.0.x adagents.json with no `formats[]` continues to validate; a
 * 3.1+ catalog populates it.
 */
export interface AdAgentsPublisherFormat {
  /** Canonical kind from v2 (`image`, `video_hosted`, `display_tag`, etc.). */
  format_kind: string;
  /** Canonical-specific parameter block (slots, dimensions, codecs, etc.). */
  params?: Record<string, unknown>;
  /** Stable identifier for this declaration; placements reference via `capability_id`. */
  capability_id?: string;
  /** Seller-controlled human-readable label. */
  display_name?: string;
  /** Subset of the publisher's property_ids this format applies to. Omit = applies to all. */
  applies_to_property_ids?: string[];
  /** Subset of the publisher's property_tags this format applies to. Omit = applies to all. */
  applies_to_property_tags?: string[];
  /**
   * Seller-asserted v1 named-format refs for v2→v1 projection. Always an
   * array per the 3.1-beta `ProductFormatDeclaration` schema — single-ref
   * is `[{...}]`, multi-size carries one entry per size.
   */
  v1_format_ref?: Array<{
    agent_url: string;
    id: string;
  }>;
  /** Opt-out of v1 emission for this declaration (custom shapes with no v1 form). */
  canonical_formats_only?: boolean;
  /** Pass-through for vendor extensions + future spec growth. */
  [k: string]: unknown;
}

/** adagents.json structure */
export interface AdAgentsJson {
  $schema?: string;
  /**
   * URL pointing to the authoritative adagents.json file.
   * When present, the client should fetch from this URL instead.
   * Used by publishers who centralize their authorization files.
   */
  authoritative_location?: string;
  authorized_agents?: AuthorizedAgent[];
  properties?: Property[];
  /**
   * Publisher-published format catalog (AdCP 3.1). Each entry declares
   * a v2 `ProductFormatDeclaration` (or v1 named-format ref) the
   * publisher's inventory accepts, optionally scoped to specific
   * properties via `applies_to_property_ids` /
   * `applies_to_property_tags`. Consumed by
   * `src/lib/v2/publisher-catalog/` for property-scoped lookup +
   * `capability_id` resolution from `placement.format_options[]`.
   * Optional; absent on 3.0.x adagents.json files.
   */
  formats?: AdAgentsPublisherFormat[];
  /**
   * Publisher domains whose inline `properties[]` entries on THIS file are
   * revoked — even if a matching entry is still present. Honored by inline
   * `publisher_properties` resolution: a selector targeting a revoked domain
   * resolves to zero properties, and the SDK MUST NOT fall through to a
   * federated fetch for that domain.
   *
   * Both parent and child adagents.json files MAY carry this field; first
   * match revokes. See adcontextprotocol/adcp#4825 + PR #4827.
   */
  revoked_publisher_domains?: string[];
  last_updated?: string;
}
