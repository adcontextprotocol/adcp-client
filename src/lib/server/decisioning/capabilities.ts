/**
 * DecisioningCapabilities — single source of truth for `get_adcp_capabilities`
 * response and any admin UI surface a host wants to render.
 *
 * Adopters declare once. Framework wires the wire-protocol response;
 * adopters' admin tools (or the SDK CLI's `validate_platform_config`) consume
 * the same dataclass so there's no drift between "what the agent says it
 * supports" and "what it actually does."
 *
 * Status: Preview / 6.0.
 *
 * @public
 */

import type { ZodSchema } from 'zod';
import type { AdCPSpecialism, MediaChannel, PricingModel } from '../../types/tools.generated';

export interface DecisioningCapabilities<TConfig = unknown> {
  /**
   * Specialisms claimed; framework type-checks these against implemented platform
   * interfaces. Arrays are `readonly` so adopters can declare with `as const`
   * (load-bearing for the `RequiredPlatformsFor<S>` compile-time gate).
   */
  specialisms: readonly AdCPSpecialism[];

  /**
   * Creative agents this seller composes with. Framework fetches format catalogs
   * from each (1h cache) and unions them on `list_creative_formats`. Self-hosting
   * sellers point at their own `agent_url`; framework calls into their
   * `CreativePlatform.listFormats()` locally instead of HTTP-fetching.
   *
   * `format_ids` filter (optional) subsets a single creative agent's catalog.
   * Useful when a creative agent hosts 50 formats but this seller only accepts
   * 10 of them. Filter scope is per-creative-agent: `[{ agent_url: A, format_ids: ['x'] }, { agent_url: B }]`
   * means "from A only format x; from B all formats."
   */
  creative_agents: readonly CreativeAgentRef[];

  /** Channels this platform sells. */
  channels: readonly MediaChannel[];

  /** Pricing models this platform supports. */
  pricingModels: readonly PricingModel[];

  /** Targeting capabilities. Optional — framework infers reasonable defaults if omitted. */
  targeting?: TargetingCapabilities;

  /** Reporting capabilities. Optional — framework infers reasonable defaults if omitted. */
  reporting?: ReportingCapabilities;

  /**
   * Billing parties this platform supports. `'operator'` = retail-media model
   * (Criteo, Amazon — operator pays the publisher and bills the brand).
   * `'agent'` = pass-through model (buyer's agent settles directly with the
   * platform). Defaults to `['agent']` when omitted.
   */
  supportedBillings?: ReadonlyArray<'operator' | 'agent'>;

  /**
   * If true, this platform refuses transactions without an authenticated
   * operator principal (operator-billed retail-media). Framework emits
   * `AUTH_REQUIRED` envelope before dispatching to the platform.
   */
  requireOperatorAuth?: boolean;

  /**
   * Platform-specific config. Strongly typed when the adopter uses the generic.
   * Example: `class GAM extends DecisioningPlatform<{ networkId: string }>`.
   */
  config: TConfig;

  /**
   * Optional Zod schema for runtime validation of `config`. When provided,
   * framework validates at platform construction time; missing or wrong-shaped
   * config rejects the agent at boot rather than at first request.
   */
  configSchema?: ZodSchema<TConfig>;
}

export interface CreativeAgentRef {
  agent_url: string;
  /** Human-readable label for this creative agent. */
  name?: string;
  /** Optional allowlist of `format_id.id` values from THIS agent's catalog. Omit to include all. */
  format_ids?: string[];
}

/**
 * Targeting capabilities the platform supports in `create_media_buy`. Maps
 * to AdCP `GetAdcpCapabilitiesResponse.media_buy.execution.targeting`.
 *
 * Shape converged across two independently-evolved peer codebases (Scope3
 * `agentic-adapters`, Prebid `salesagent`). Per-geo-system flags rather than
 * coarse enums because the two implementations agreed: real platforms support
 * specific geo identifier formats (Nielsen DMA, Eurostat NUTS2, US ZIP+4), not
 * abstract "metro" / "postal" categories.
 */
export interface TargetingCapabilities {
  geo_countries?: boolean;
  geo_regions?: boolean;

  /** Metro / DMA identifier systems. */
  geo_metros?: {
    nielsen_dma?: boolean;
    uk_itl1?: boolean;
    uk_itl2?: boolean;
    eurostat_nuts2?: boolean;
  };

  /** Postal-code identifier systems. */
  geo_postal_areas?: {
    us_zip?: boolean;
    us_zip_plus_four?: boolean;
    gb_outward?: boolean;
    gb_full?: boolean;
    ca_fsa?: boolean;
    ca_full?: boolean;
    de_plz?: boolean;
    fr_code_postal?: boolean;
    au_postcode?: boolean;
    ch_plz?: boolean;
    at_plz?: boolean;
  };

  /** Geographic-proximity targeting (radius / drive-time / arbitrary geometry). */
  geo_proximity?: {
    radius?: boolean;
    travel_time?: boolean;
    geometry?: boolean;
    transport_modes?: ReadonlyArray<'walking' | 'cycling' | 'driving' | 'public_transport'>;
  };

  /** Age-restriction targeting; `verification_methods` enumerates the assurance levels accepted. */
  age_restriction?: {
    supported?: boolean;
    verification_methods?: ReadonlyArray<
      'facial_age_estimation' | 'id_document' | 'digital_id' | 'credit_card' | 'world_id'
    >;
  };

  device_platform?: boolean;
  device_type?: boolean;
  language?: boolean;
  audience_include?: boolean;
  audience_exclude?: boolean;

  /** Keyword-targeting match types accepted on positive-match terms. */
  keyword_targets?: {
    supported_match_types: ReadonlyArray<'broad' | 'phrase' | 'exact'>;
  };

  /** Negative-keyword match types accepted. */
  negative_keywords?: {
    supported_match_types: ReadonlyArray<'broad' | 'phrase' | 'exact'>;
  };
}

/**
 * Reporting capabilities the platform supports in `get_media_buy_delivery`.
 *
 * `availableDimensions` is the breakdown axes the platform can group
 * delivery rows by. Vocabulary converged across Scope3 and Prebid.
 */
export interface ReportingCapabilities {
  frequencies: ReadonlyArray<'hourly' | 'daily' | 'weekly'>;
  expected_delay_minutes: number;
  timezone: string;
  metrics: string[];
  date_range_support: 'date_range' | 'fixed_only';
  supports_webhooks: boolean;
  availableDimensions?: ReadonlyArray<
    'geo' | 'device_type' | 'device_platform' | 'audience' | 'placement' | 'creative' | 'keyword' | 'catalog_item'
  >;
}
