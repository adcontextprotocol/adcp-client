/**
 * DecisioningPlatform — the top-level interface adopters implement.
 *
 * Per-specialism sub-interfaces (sales, creative, audiences, etc.) are
 * optional; framework's compile-time enforcement (RequiredPlatformsFor<S>)
 * forces the right sub-interfaces based on `capabilities.specialisms[]`.
 *
 * Status: Preview / 6.0. Not yet wired into the framework.
 *
 * @public
 */

import type { DecisioningCapabilities, BrandCapabilities } from './capabilities';
import type { Account, AccountStore } from './account';
import type { StatusMappers } from './status-mappers';
import type { SalesPlatform } from './specialisms/sales';
import type { CreativeBuilderPlatform } from './specialisms/creative';
import type { CreativeAdServerPlatform } from './specialisms/creative-ad-server';
import type { AudiencePlatform } from './specialisms/audiences';
import type { SignalsPlatform } from './specialisms/signals';
import type { CampaignGovernancePlatform } from './specialisms/campaign-governance';
import type { ContentStandardsPlatform } from './specialisms/content-standards';
import type { BrandRightsPlatform } from './specialisms/brand-rights';
import type { PropertyListsPlatform, CollectionListsPlatform } from './specialisms/lists';
import type { AdCPSpecialism } from '../../types/tools.generated';

/**
 * Top-level platform interface. Adopters implement this; framework wires
 * the wire protocol around it.
 *
 * The "framework owns X" claims below are the v6.0 wiring contract — the
 * runtime guarantees the framework will provide once this surface is wired.
 * They are NOT yet enforced; this module is preview-only as of the scaffold
 * landing. Treat them as the design contract a v6.0 reviewer should hold
 * the framework refactor to, not as a description of existing behavior.
 *
 * **What the framework owns** (platform implementations DON'T see these):
 * - Wire-shape mapping (MCP tools/list, A2A skill manifest, request/response envelopes)
 * - Authentication + auth-principal extraction; `accounts.resolve()` is the only
 *   place the platform translates auth into its tenant model
 * - Idempotency: dedupe + replay handled before dispatch; platforms see clean traffic
 * - `sandbox` boundary: when `AccountReference.sandbox === true`, framework
 *   resolves the buyer's sandbox account via `accounts.resolve()`. The platform
 *   sees the resolved sandbox `Account` like any other and is responsible for
 *   routing reads/writes to its sandbox backend. There is no separate
 *   "dry-run" mode — sandbox subsumes "validate against real platform without
 *   writing to production." Tool-specific `dry_run` flags on `sync_catalogs`
 *   and `sync_creatives` are wire fields the platform receives and honors;
 *   they are NOT a framework-level mode.
 * - `context` echo: framework round-trips `context` on every response
 * - Task envelopes: `submitted` outcomes are wrapped into A2A Task envelopes /
 *   MCP polling responses; `taskHandle.notify` calls dedupe + retry
 * - Schema validation: requests fail before reaching the platform; responses are
 *   shape-validated against the wire schema after the platform returns
 *
 * **What the platform owns**: the business decisions in each `SalesPlatform` /
 * `CreativeBuilderPlatform` / `AudiencePlatform` method. Nothing else.
 *
 * @template TConfig Platform-specific config typed at the call site.
 *                   Example: `class GAM implements DecisioningPlatform<{ networkId: string }>`.
 * @template TCtxMeta Shape of the platform's opaque ctx_metadata blob — typed
 *                    once and propagated into `ctx.account.ctx_metadata`,
 *                    `ctx.ctxMetadata.get()`, and every specialism handler.
 */
export interface DecisioningPlatform<TConfig = unknown, TCtxMeta = Record<string, unknown>> {
  /** Capability declaration; single source of truth for get_adcp_capabilities. */
  capabilities: DecisioningCapabilities<TConfig>;

  /** Account model + tenant resolution. */
  accounts: AccountStore<TCtxMeta>;

  /**
   * Native-status mappers (account, mediaBuy, creative, plan).
   *
   * **Optional.** Default behavior treats the platform's status strings as
   * already-canonical AdCP status values (no translation). Provide mappers
   * only when your platform exposes non-AdCP status strings (e.g., GAM's
   * `DELIVERY_PAUSED` → AdCP's `paused`).
   */
  statusMappers?: StatusMappers;

  /**
   * Per-tenant capability override. Multi-tenant SaaS adopters (Prebid-style
   * deployments where one server hosts many advertisers, each with different
   * `manualApprovalOperations` / pricing tiers / channel mixes) implement this
   * to scope capabilities per resolved Account. When absent, the framework
   * uses `capabilities` for every request.
   *
   * The framework calls this AFTER `accounts.resolve()` and uses the returned
   * capabilities to gate the rest of the request. The static `agent-card.json`
   * AND `tools/list` shape is derived from `capabilities` (the union) — per-tenant
   * differences are runtime-only.
   */
  getCapabilitiesFor?(
    account: Account<TCtxMeta>
  ): DecisioningCapabilities<TConfig> | Promise<DecisioningCapabilities<TConfig>>;

  // Per-specialism sub-interfaces — optional at the type level; required at the
  // call site by RequiredPlatformsFor<S>. v1.0 ships these. Each is parameterized
  // by `TCtxMeta` so adopters get typed `ctx.account.ctx_metadata` access in their
  // method bodies without casting.
  sales?: SalesPlatform<TCtxMeta>;
  creative?: CreativeBuilderPlatform<TCtxMeta> | CreativeAdServerPlatform<TCtxMeta>;
  audiences?: AudiencePlatform<TCtxMeta>;
  signals?: SignalsPlatform<TCtxMeta>;
  campaignGovernance?: CampaignGovernancePlatform<TCtxMeta>;
  contentStandards?: ContentStandardsPlatform<TCtxMeta>;
  propertyLists?: PropertyListsPlatform<TCtxMeta>;
  collectionLists?: CollectionListsPlatform<TCtxMeta>;
  brandRights?: BrandRightsPlatform<TCtxMeta>;

  // v1.1+ specialisms add: creative-review, plus the 2 brand-rights wire
  // tools awaiting AdcpToolMap landing (`update_rights`, `creative_approval`).
}

// ---------------------------------------------------------------------------
// Compile-time capability enforcement
// ---------------------------------------------------------------------------

/**
 * Maps an AdCP specialism to the platform interface(s) it requires. The
 * framework's `createAdcpServer<P extends DecisioningPlatform>` constrains
 * `P` to satisfy `RequiredPlatformsFor<P['capabilities']['specialisms'][number]>`,
 * forcing every claimed specialism's interface methods to exist.
 *
 * Drop a method, fail compile.
 * Claim a specialism without an implementation, fail compile.
 *
 * The nested-conditional encoding (rather than a union of `S extends X ? {} : never`)
 * is deliberate: when a specialism is claimed without its required platform
 * interface, TypeScript surfaces "Property 'sales' is missing in type 'P'"
 * rather than the unactionable "Type 'P' does not satisfy the constraint 'never'."
 *
 * v1.0 covers the 4 specialisms shipping in v1.0; extended in v1.1+.
 * Unknown specialisms (v1.1+ when this module hasn't been updated yet)
 * resolve to an empty requirement — the framework's runtime check is the
 * fallback gate.
 */
// Sales specialisms — all share the SalesPlatform interface but route through
// different storyboards on the buyer side. Adopter implements `sales` once;
// claiming any of these specialisms compile-checks for the same field.
// Wired per the AdCP 3.0 GA enum; preview specialisms (sales-streaming-tv,
// sales-exchange, sales-retail-media) get added when they land in spec.
type SalesSpecialism =
  | 'sales-non-guaranteed'
  | 'sales-guaranteed'
  | 'sales-broadcast-tv'
  | 'sales-social'
  | 'sales-catalog-driven'
  | 'sales-proposal-mode';

// Signal specialisms — both share the SignalsPlatform interface. Marketplace
// = third-party data brokers; owned = first-party data providers.
type SignalSpecialism = 'signal-marketplace' | 'signal-owned';

// Today's spec splits campaign governance into spend-authority + delivery-monitor;
// both share one CampaignGovernancePlatform interface. When adcp#3329 lands and
// the spec consolidates to `campaign-governance`, this union shrinks to one
// value without shape changes.
type CampaignGovernanceSpecialism = 'governance-spend-authority' | 'governance-delivery-monitor';

// `TCtxMeta` defaults to `any` so callers that don't pass it explicitly (the
// common case — `RequiredPlatformsFor<S>` without a second argument) get a
// constraint that accepts any adopter metadata shape. The `any` is not a
// soundness escape — adopters declare metadata inside `DecisioningPlatform<_,
// TCtxMeta>` directly; this constraint exists only to compile-check that
// claimed specialisms have a matching sub-interface field on the platform.
export type RequiredPlatformsFor<
  S extends AdCPSpecialism,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TCtxMeta = any,
> = S extends 'creative-template' | 'creative-generative'
  ? { creative: CreativeBuilderPlatform<TCtxMeta> }
  : S extends 'creative-ad-server'
    ? { creative: CreativeAdServerPlatform<TCtxMeta> }
    : S extends SalesSpecialism
      ? { sales: SalesPlatform<TCtxMeta> }
      : S extends 'audience-sync'
        ? { audiences: AudiencePlatform<TCtxMeta> }
        : S extends SignalSpecialism
          ? { signals: SignalsPlatform<TCtxMeta> }
          : S extends CampaignGovernanceSpecialism
            ? { campaignGovernance: CampaignGovernancePlatform<TCtxMeta> }
            : S extends 'property-lists'
              ? { propertyLists: PropertyListsPlatform<TCtxMeta> }
              : S extends 'collection-lists'
                ? { collectionLists: CollectionListsPlatform<TCtxMeta> }
                : S extends 'content-standards'
                  ? { contentStandards: ContentStandardsPlatform<TCtxMeta> }
                  : S extends 'brand-rights'
                    ? { brandRights: BrandRightsPlatform<TCtxMeta> }
                    : Record<string, never>;

/**
 * The framework's createAdcpServer<P> signature uses this intersection to
 * enforce capability claims at compile time. Sketch:
 *
 * ```ts
 * declare function createAdcpServer<P extends DecisioningPlatform>(config: {
 *   platform: P & RequiredPlatformsFor<P['capabilities']['specialisms'][number]>;
 * }): AdcpServer;
 * ```
 *
 * NOTE: The companion file is preview-only; the actual `createAdcpServer`
 * doesn't yet enforce this. Wiring lands in a follow-up PR with the
 * framework refactor.
 */

/**
 * Compile-time mapping from a claimed specialism to the capability
 * blocks the framework requires on `DecisioningCapabilities`. Sister
 * type to `RequiredPlatformsFor<S>` — that one constrains the per-
 * specialism platform interfaces; this one constrains capability-block
 * declarations on `capabilities.*`.
 *
 * Mappings populated conservatively in v1.0:
 *
 *   - `'brand-rights'` → `{ brand: BrandCapabilities }`. Adopters
 *     claiming brand-rights MUST declare `capabilities.brand`. The
 *     framework auto-derives `rights: true` from the
 *     `BrandRightsPlatform` impl, but adopters still need to declare
 *     the block (even as `{}`) so `right_types`, `available_uses`,
 *     etc. land coherently in `get_adcp_capabilities`.
 *
 * Other specialisms have no required capability blocks today —
 * `audience_targeting` is recommended for `audience-sync` adopters but
 * not enforced (some sync platforms accept anonymous IDs only and
 * legitimately have no `supported_identifier_types` to declare).
 *
 * The `& Record<string, never>` fallthrough means specialisms not
 * mapped here add no constraint — adopters can claim them without
 * declaring extra capability blocks.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type RequiredCapabilitiesFor<S extends AdCPSpecialism> = S extends 'brand-rights'
  ? { capabilities: { brand: BrandCapabilities } }
  : {};
// `{}` (not `Record<string, never>`) is the right "no extra requirements"
// fallthrough: it intersects to identity (`P & {} = P`) for specialisms
// without capability constraints. `Record<string, never>` would force the
// platform to have NO extra properties, which would reject every real
// platform impl.
