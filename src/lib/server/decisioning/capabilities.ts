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
  PaymentTerms,
  PricingModel,
  GetAdCPCapabilitiesResponse,
  PostalAreaSupport,
} from '../../types/tools.generated';
import type { ProductMetricOptimizationLike } from '../../utils/capability-rollups';
import type { MediaBuyFeatures, AccountCapabilities, CreativeCapabilities } from '../../utils/capabilities';
import type { AdcpCapabilitiesOverrides } from '../create-adcp-server';

/**
 * Pre-resolved alias for the wire `media_buy` block. Used as the projection
 * source for the five `media_buy.*` capability fields below so each typed
 * field references a single resolved shape instead of re-walking the
 * `GetAdCPCapabilitiesResponse` type graph independently. Without the
 * alias, `strict + skipLibCheck:false` adopters hit the TS instantiation
 * budget on the published `.d.ts` and tsc OOMs.
 */
type _MediaBuyCapabilities = NonNullable<GetAdCPCapabilitiesResponse['media_buy']>;
type _MediaBuyTargetingCapabilities = NonNullable<NonNullable<_MediaBuyCapabilities['execution']>['targeting']>;
type _ComplianceTestingScenario = NonNullable<
  NonNullable<GetAdCPCapabilitiesResponse['compliance_testing']>['scenarios']
>[number];

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
   *
   * Omit for signals-only platforms (`signal-marketplace`, `signal-owned`) — they
   * sell audience data access, not media inventory, and don't compose with creative agents.
   */
  creative_agents?: readonly CreativeAgentRef[];

  /**
   * Channels this platform sells.
   *
   * Omit for non-media-buy platforms — they don't sell ad inventory and have no
   * channels to declare. Applies to signals (`signal-marketplace`, `signal-owned`),
   * governance (`governance-spend-authority`, `governance-delivery-monitor`,
   * `property-lists`, `collection-lists`, `content-standards`), creative-only
   * (`creative-ad-server`, `creative-template`, `creative-generative`), and
   * brand (`brand-rights`) platforms.
   *
   * **Required at runtime for media-buy platforms.** `validatePlatform` (called
   * by `createAdcpServerFromPlatform`) throws `PlatformConfigError` when any
   * `sales-*` specialism is claimed and this field is absent.
   */
  channels?: readonly MediaChannel[];

  /**
   * Pricing models this platform supports.
   *
   * Omit for non-media-buy platforms — they don't sell ad inventory and have no
   * channel-level pricing to declare. For signals platforms specifically, pricing
   * is declared per-signal in the signal descriptor's `pricing_options[]` instead.
   * Same non-media-buy specialism set as `channels` above.
   *
   * **Required at runtime for media-buy platforms.** `validatePlatform` (called
   * by `createAdcpServerFromPlatform`) throws `PlatformConfigError` when any
   * `sales-*` specialism is claimed and this field is absent.
   */
  pricingModels?: readonly PricingModel[];

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
  audience_targeting?: NonNullable<_MediaBuyCapabilities['audience_targeting']>;

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
  conversion_tracking?: NonNullable<_MediaBuyCapabilities['conversion_tracking']>;

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
  content_standards?: NonNullable<_MediaBuyCapabilities['content_standards']>;

  /**
   * Seller-level rollup of optimization metrics — projected onto
   * `get_adcp_capabilities.media_buy.supported_optimization_metrics`.
   * Added in AdCP 3.1 (adcp#4669). The array union of every product's
   * `metric_optimization.supported_metrics`. Storyboard runners gate
   * `metric_optimization`-using scenarios on this field; declaring it
   * gives buyers an upfront signal of which optimization metrics the
   * seller can compute against (clicks, views, completed_views, etc.).
   *
   * Adopters can compute the rollup from their catalog using the
   * exported {@link rollupOptimizationMetricsFromProducts} helper —
   * keeps the declaration in sync with what products actually offer.
   * Empty arrays are normalized away and the wire field is omitted; use
   * omission to mean "no seller-level metric rollup advertised".
   *
   * Wire spec: `core/get-adcp-capabilities-response.json#media_buy.supported_optimization_metrics`.
   */
  supported_optimization_metrics?: NonNullable<_MediaBuyCapabilities['supported_optimization_metrics']>;

  /**
   * Static product-metric summary used for capability rollups.
   *
   * When this is present and `supported_optimization_metrics` is omitted,
   * the framework derives `media_buy.supported_optimization_metrics` as the
   * sorted union of every product summary's
   * `metric_optimization.supported_metrics`. Full AdCP `Product` objects work,
   * but this field is not a general product-discovery surface; a lightweight
   * startup summary with just the `metric_optimization` block is enough.
   * Dynamic per-account catalogs should continue to pass an explicit
   * `supported_optimization_metrics` override. If the derived union is empty,
   * the framework omits `supported_optimization_metrics` from the wire
   * capabilities response.
   */
  productCatalog?: ReadonlyArray<ProductMetricOptimizationLike>;

  /**
   * Frequency-cap support declaration — projected onto
   * `get_adcp_capabilities.media_buy.frequency_capping`. Added in AdCP
   * 3.1 (adcp#4670). Presence-only object with `supported_per_units` /
   * `supported_window_units` sub-fields declaring which frequency-cap
   * shapes the platform honors. Omit when the platform doesn't accept
   * frequency caps at all; buyers will avoid the field on `pacing.*`.
   *
   * Wire spec: `core/get-adcp-capabilities-response.json#media_buy.frequency_capping`.
   */
  frequency_capping?: NonNullable<_MediaBuyCapabilities['frequency_capping']>;

  /**
   * Whether this seller commits to the proposal lifecycle on get_products.
   * Projected onto `get_adcp_capabilities.media_buy.supports_proposals`.
   * Direct-buy sellers should declare `false` so proposal-only compliance
   * storyboards are skipped; sellers with a ProposalManager are auto-derived
   * as `true` unless they override this explicitly.
   */
  supportsProposals?: boolean;

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
   * the deployment supports deterministic state-machine testing via the
   * `comply_test_controller` wire tool. Keep this block declared when using
   * `createAdcpServerFromPlatform(..., { complyTest })`; the framework makes
   * live principals byte-identical to a production seller that never wired the
   * controller by hiding this block, filtering `tools/list`, and returning MCP
   * method-not-found for direct live calls.
   *
   * When this block is present, `createAdcpServerFromPlatform` REQUIRES
   * `opts.complyTest` (the `ComplyControllerConfig` adapter set) to be
   * supplied — claiming the capability without implementing the
   * controller is a `PlatformConfigError` at construction.
   *
   * Inversely, supplying `opts.complyTest` without declaring this
   * capability is also caught — the framework derives `scenarios` from
   * the declared force/simulate/seed adapters and emits the discovery
   * field on `get_adcp_capabilities` automatically for sandbox/mock
   * principals. Live principals do not see the block.
   */
  compliance_testing?: ComplianceTestingCapabilities;

  /**
   * Billing parties this platform supports. `'operator'` = retail-media model
   * (Criteo, Amazon — operator pays the publisher and bills the brand).
   * `'agent'` = pass-through model (buyer's agent settles directly with the
   * platform). `'advertiser'` = seller invoices the advertiser directly,
   * bypassing operator settlement (advertiser-direct sell-side platforms where
   * the brand is the direct contractual counterparty). Defaults to `['agent']`
   * when omitted. To express advertiser-direct billing per account, set
   * `billing.invoicedTo` to a `BrandReference` (the framework maps any
   * `BrandReference` to `'advertiser'` on the wire).
   */
  supportedBillings?: ReadonlyArray<'operator' | 'agent' | 'advertiser'>;

  /**
   * Payment terms this platform accepts on `sync_accounts.payment_terms`.
   * Omit to leave terms validation to `accounts.upsert` (or to accept any
   * schema-valid value). When present, the framework rejects unsupported
   * requested terms with `PAYMENT_TERMS_NOT_SUPPORTED` before dispatching
   * the account entry to the adopter.
   */
  supportedPaymentTerms?: ReadonlyArray<PaymentTerms>;

  /**
   * If true, this platform refuses transactions without an authenticated
   * operator principal (operator-billed retail-media). Framework emits
   * `AUTH_REQUIRED` envelope before dispatching to the platform.
   */
  requireOperatorAuth?: boolean;

  /**
   * Media-buy feature flags forwarded into `get_adcp_capabilities.media_buy.features`.
   * Adopter values serve as the base; auto-derived `audience_targeting`,
   * `conversion_tracking`, and `content_standards` booleans take precedence
   * for those three keys (overlaid by the framework via the per-domain
   * `media_buy` override on the inner createAdcpServer call). Use this to
   * declare `inlineCreativeManagement` and `propertyListFiltering` directly
   * from `definePlatform`; declare not-supported feature blocks (e.g.
   * `inlineCreativeManagement: false`) so the conformance runner grades
   * them `not_applicable` instead of `fail`.
   *
   * Resolves the `definePlatform` passthrough gap noted in adcp-client#2199.
   */
  features?: Partial<MediaBuyFeatures>;

  /**
   * Creative-protocol capabilities forwarded into `get_adcp_capabilities.creative`.
   * Use to declare `supportsCompliance`, `hasCreativeLibrary`,
   * `supportsGeneration`, and `supportsTransformation` from `definePlatform`.
   * Adopters that don't run a provenance-verification pipeline should
   * declare the relevant fields as `false` so creative storyboards gate
   * cleanly.
   *
   * Resolves the `definePlatform` passthrough gap noted in adcp-client#2199.
   */
  creative?: Partial<CreativeCapabilities>;

  /**
   * Account capabilities forwarded into `get_adcp_capabilities.account` as a
   * base layer. The framework's existing `requireOperatorAuth` and
   * `supportedBillings` projections overlay on top via the per-domain
   * `account` override, so explicit projections win on those keys.
   * `authorizationEndpoint`, `defaultBilling`, `requiredForProducts`, and
   * `sandbox` are pure adopter-driven additions exposed through this slot.
   *
   * Resolves the `definePlatform` passthrough gap noted in adcp-client#2199.
   */
  account?: Partial<AccountCapabilities>;

  /**
   * Deep-merge overrides applied to the wire `get_adcp_capabilities`
   * response. Use this for fields that the top-level `DecisioningCapabilities`
   * shape doesn't model — `media_buy.propagation_surfaces`,
   * `media_buy.measurement_terms`, `signals.discovery_modes`, etc. The
   * framework's per-domain projections (auto-derived `media_buy`, `brand`,
   * `account`, `compliance_testing` blocks) are merged AFTER adopter
   * overrides, so framework-derived values remain authoritative on the keys
   * the projection engine handles.
   *
   * Mirrors `AdcpCapabilitiesConfig.overrides` on the lower-level
   * `createAdcpServer` API. Resolves the `definePlatform` passthrough gap
   * noted in adcp-client#2199.
   */
  overrides?: AdcpCapabilitiesOverrides;

  /**
   * Release-precision AdCP versions this platform supports (e.g. `["3.0", "3.1"]`).
   * Forwarded into `get_adcp_capabilities.adcp.supported_versions`. 3.1+
   * sellers should declare here the same release-precision strings they
   * emit in `adcp_version` on responses; 3.0-pinned sellers can omit.
   *
   * Resolves the same gap previously noted for `supported_versions` —
   * was unreachable through `definePlatform` because
   * `CreateAdcpServerFromPlatformOptions` omits `'capabilities'` from
   * `AdcpServerConfig`. See adcp-client#2199.
   */
  supported_versions?: string[];

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

  /**
   * Postal-code identifier systems.
   *
   * AdCP 3.1.0-rc.10 prefers country-keyed arrays, e.g.
   * `{ US: ['zip'], GB: ['outward'] }`. Deprecated country-fused booleans
   * such as `{ us_zip: true }` remain accepted for 3.x adopters; the
   * framework projects both forms with `normalizePostalAreaSupport()` so old
   * and new buyers can read the capability safely during the migration.
   */
  geo_postal_areas?: TargetingPostalAreaSupport;

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

export type TargetingPostalAreaSupport = {
  US?: readonly ('zip' | 'zip_plus_four')[];
  GB?: readonly ('outward' | 'full')[];
  CA?: readonly ('fsa' | 'full')[];
  DE?: readonly 'plz'[];
  CH?: readonly 'plz'[];
  AT?: readonly 'plz'[];
  FR?: readonly 'code_postal'[];
  AU?: readonly 'postcode'[];
  BR?: readonly 'cep'[];
  IN?: readonly 'pin'[];
  ZA?: readonly 'postal_code'[];
  /** @deprecated Use `US: ['zip']`. */
  us_zip?: boolean;
  /** @deprecated Use `US: ['zip_plus_four']`. */
  us_zip_plus_four?: boolean;
  /** @deprecated Use `GB: ['outward']`. */
  gb_outward?: boolean;
  /** @deprecated Use `GB: ['full']`. */
  gb_full?: boolean;
  /** @deprecated Use `CA: ['fsa']`. */
  ca_fsa?: boolean;
  /** @deprecated Use `CA: ['full']`. */
  ca_full?: boolean;
  /** @deprecated Use `DE: ['plz']`. */
  de_plz?: boolean;
  /** @deprecated Use `FR: ['code_postal']`. */
  fr_code_postal?: boolean;
  /** @deprecated Use `AU: ['postcode']`. */
  au_postcode?: boolean;
  /** @deprecated Use `CH: ['plz']`. */
  ch_plz?: boolean;
  /** @deprecated Use `AT: ['plz']`. */
  at_plz?: boolean;
  [country: `${Uppercase<string>}`]:
    | readonly (
        | 'zip'
        | 'zip_plus_four'
        | 'outward'
        | 'full'
        | 'fsa'
        | 'plz'
        | 'code_postal'
        | 'postcode'
        | 'cep'
        | 'pin'
        | 'postal_code'
        | 'custom'
      )[]
    | undefined;
};

const LEGACY_POSTAL_SYSTEMS = {
  us_zip: { country: 'US', system: 'zip' },
  us_zip_plus_four: { country: 'US', system: 'zip_plus_four' },
  gb_outward: { country: 'GB', system: 'outward' },
  gb_full: { country: 'GB', system: 'full' },
  ca_fsa: { country: 'CA', system: 'fsa' },
  ca_full: { country: 'CA', system: 'full' },
  de_plz: { country: 'DE', system: 'plz' },
  fr_code_postal: { country: 'FR', system: 'code_postal' },
  au_postcode: { country: 'AU', system: 'postcode' },
  ch_plz: { country: 'CH', system: 'plz' },
  at_plz: { country: 'AT', system: 'plz' },
} as const;

const LEGACY_POSTAL_BY_COUNTRY_SYSTEM = new Map(
  Object.entries(LEGACY_POSTAL_SYSTEMS).map(([legacy, { country, system }]) => [`${country}:${system}`, legacy])
);

const POSTAL_SYSTEMS_BY_COUNTRY: Record<string, readonly string[]> = {
  US: ['zip', 'zip_plus_four'],
  GB: ['outward', 'full'],
  CA: ['fsa', 'full'],
  DE: ['plz'],
  CH: ['plz'],
  AT: ['plz'],
  FR: ['code_postal'],
  AU: ['postcode'],
  BR: ['cep'],
  IN: ['pin'],
  ZA: ['postal_code'],
};

const GENERIC_POSTAL_SYSTEMS = ['postal_code', 'custom'] as const;
const POSTAL_COUNTRY_KEY_PATTERN = /^[A-Z]{2}$/;

function appendUnique(target: string[], value: string): void {
  if (!target.includes(value)) target.push(value);
}

function assertSupportedPostalSystems(country: string, systems: readonly string[]): void {
  const allowed = POSTAL_SYSTEMS_BY_COUNTRY[country] ?? GENERIC_POSTAL_SYSTEMS;
  const invalid = systems.filter(system => !allowed.includes(system));
  if (invalid.length > 0) {
    throw new Error(
      `Invalid geo_postal_areas support for ${country}: ${invalid.join(', ')}. ` +
        `Supported systems are: ${allowed.join(', ')}.`
    );
  }
}

/**
 * Normalize postal-area capabilities across the AdCP 3.1.0-rc.10 migration.
 *
 * The wire schema now prefers `{ US: ['zip'] }` style country-local systems,
 * while the old `{ us_zip: true }` booleans stay deprecated but accepted
 * through 3.x. This helper is deliberately bidirectional:
 *
 * - legacy booleans add their country-keyed system;
 * - country-keyed systems backfill the matching legacy boolean when one exists;
 * - explicit unsupported legacy booleans are omitted unless the system is
 *   otherwise advertised.
 */
export function normalizePostalAreaSupport(input: TargetingPostalAreaSupport): PostalAreaSupport {
  const normalized: Record<string, string[] | boolean> = {};

  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      if (!POSTAL_COUNTRY_KEY_PATTERN.test(key)) {
        throw new Error(
          `Invalid geo_postal_areas key "${key}". Use an ISO 3166-1 alpha-2 country code or a deprecated legacy boolean alias.`
        );
      }
      assertSupportedPostalSystems(key, value);
      const systems = (normalized[key] = Array.isArray(normalized[key]) ? (normalized[key] as string[]) : []);
      for (const system of value) appendUnique(systems, system);
      continue;
    }
    if (value === true && key in LEGACY_POSTAL_SYSTEMS) {
      const { country, system } = LEGACY_POSTAL_SYSTEMS[key as keyof typeof LEGACY_POSTAL_SYSTEMS];
      const systems = (normalized[country] = Array.isArray(normalized[country])
        ? (normalized[country] as string[])
        : []);
      appendUnique(systems, system);
      continue;
    }
    if (value === true) {
      throw new Error(
        `Invalid geo_postal_areas legacy alias "${key}". Use an ISO 3166-1 alpha-2 country key with supported postal systems.`
      );
    }
  }

  for (const [country, value] of Object.entries(normalized)) {
    if (!Array.isArray(value)) continue;
    for (const system of value) {
      const legacy = LEGACY_POSTAL_BY_COUNTRY_SYSTEM.get(`${country}:${system}`);
      if (legacy) normalized[legacy] = true;
    }
  }

  return normalized as PostalAreaSupport;
}

export function normalizeTargetingCapabilities(input: TargetingCapabilities): _MediaBuyTargetingCapabilities {
  return {
    ...input,
    ...(input.geo_postal_areas && { geo_postal_areas: normalizePostalAreaSupport(input.geo_postal_areas) }),
  } as _MediaBuyTargetingCapabilities;
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
   * canonical scenario enum, excluding `list_scenarios` because that
   * is a discovery operation rather than a test capability. Framework
   * defaults this from the adopter-supplied `complyTest` adapter set
   * when omitted.
   */
  scenarios?: ReadonlyArray<_ComplianceTestingScenario>;
}
