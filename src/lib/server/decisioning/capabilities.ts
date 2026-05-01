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
import type {
  AdCPSpecialism,
  MediaChannel,
  PricingModel,
  GetAdCPCapabilitiesResponse,
} from '../../types/tools.generated';

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
   * Audience-matching capabilities — projected onto
   * `get_adcp_capabilities.media_buy.audience_targeting`. Required for
   * audience-sync adopters (CRM-list adopters that accept hashed
   * identifiers + UID types) so buyers know which identifier shapes
   * the platform will match against and what minimum audience size /
   * matching latency to expect. Omit when the platform doesn't accept
   * external audience uploads.
   *
   * Wire spec: `core/get-adcp-capabilities-response.json#media_buy.audience_targeting`.
   */
  audience_targeting?: NonNullable<NonNullable<GetAdCPCapabilitiesResponse['media_buy']>['audience_targeting']>;

  /**
   * Conversion-tracking capabilities — projected onto
   * `get_adcp_capabilities.media_buy.conversion_tracking`. Required for
   * adopters that accept conversion events via `sync_event_sources` /
   * `log_event` so buyers know which event types, action sources,
   * attribution windows, and identifier shapes the platform supports.
   * Omit when the platform doesn't track conversions.
   *
   * Wire spec: `core/get-adcp-capabilities-response.json#media_buy.conversion_tracking`.
   */
  conversion_tracking?: NonNullable<NonNullable<GetAdCPCapabilitiesResponse['media_buy']>['conversion_tracking']>;

  /**
   * Content-standards capabilities — projected onto
   * `get_adcp_capabilities.media_buy.content_standards`. Required for
   * adopters claiming the `content-standards` specialism so buyers know
   * whether the platform runs local evaluation, which channels it
   * covers, and whether it supports webhook artifact delivery. Omit
   * when the platform doesn't ship content-standards artifacts.
   *
   * Wire spec: `core/get-adcp-capabilities-response.json#media_buy.content_standards`.
   */
  content_standards?: NonNullable<NonNullable<GetAdCPCapabilitiesResponse['media_buy']>['content_standards']>;

  /**
   * Brand-protocol capabilities. Projected onto the wire `brand` block of
   * `get_adcp_capabilities` (`brand: { rights, right_types, available_uses,
   * generation_providers, description }`). The framework auto-derives
   * `rights: true` when `BrandRightsPlatform` is supplied; adopters
   * declare the rest (right_types they license, RightUses they support,
   * generation providers they issue credentials for).
   *
   * REQUIRED when claiming the `'brand-rights'` specialism — enforced at
   * compile-time via `RequiredCapabilitiesFor<S>`.
   */
  brand?: BrandCapabilities;

  /**
   * Compliance-testing capabilities. The presence of this block declares
   * the agent supports deterministic state-machine testing via the
   * `comply_test_controller` wire tool. Omit entirely if the agent
   * doesn't support compliance testing.
   *
   * When this block is present, `createAdcpServerFromPlatform` REQUIRES
   * `opts.complyTest` (the `ComplyControllerConfig` adapter set) to be
   * supplied — claiming the capability without implementing the
   * controller is a `PlatformConfigError` at construction.
   *
   * Inversely, supplying `opts.complyTest` without declaring this
   * capability is also caught — the framework derives `scenarios` from
   * the declared force/simulate/seed adapters and emits the discovery
   * field on `get_adcp_capabilities` automatically. Adopters who want
   * to explicitly declare a narrower or wider scenarios list can supply
   * this block; otherwise the auto-derivation wins.
   */
  compliance_testing?: ComplianceTestingCapabilities;

  /**
   * Billing parties this platform supports. `'operator'` = retail-media model
   * (Criteo, Amazon — operator pays the publisher and bills the brand).
   * `'agent'` = pass-through model (buyer's agent settles directly with the
   * platform). Defaults to `[]` (no billing preference declared) when omitted;
   * the framework always emits `account.supported_billing` on the wire.
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

/**
 * Brand-protocol capabilities — projected onto the wire `brand` block of
 * `get_adcp_capabilities` via the framework's `overrides.brand` deep-merge
 * seam. Adopters who also implement `BrandRightsPlatform` get
 * `rights: true` auto-derived; the other four fields (`right_types`,
 * `available_uses`, `generation_providers`, `description`) are
 * adopter-declared.
 *
 * Wire spec: `protocol/get-adcp-capabilities-response.json#brand`.
 */
export type BrandCapabilities = NonNullable<NonNullable<GetAdCPCapabilitiesResponse['brand']>>;

/**
 * Compliance-testing capabilities — projected onto the wire-side
 * `compliance_testing` block of `get_adcp_capabilities` so buyers and
 * conformance harnesses can discover which `comply_test_controller`
 * scenarios the agent supports.
 *
 * Wire spec: `core/get-adcp-capabilities-response.json#compliance_testing`.
 *
 * The `scenarios` array MUST be non-empty when this block is declared
 * (per the spec). `'list_scenarios'` is implicit — adopters don't need
 * to enumerate it.
 */
export interface ComplianceTestingCapabilities {
  /**
   * Scenarios this agent advertises support for. Wire enum is the
   * spec-narrowed force + simulate set; seed scenarios are
   * deliberately NOT advertised here (the controller's own
   * `list_scenarios` response follows the same rule). Adopters who
   * wire seed adapters get them dispatched correctly at runtime; they
   * just don't appear in capability discovery. Framework defaults
   * this from the adopter-supplied `complyTest` adapter set when
   * omitted.
   */
  scenarios?: ReadonlyArray<
    | 'force_creative_status'
    | 'force_account_status'
    | 'force_media_buy_status'
    | 'force_session_status'
    | 'simulate_delivery'
    | 'simulate_budget_spend'
  >;
}
