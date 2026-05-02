/**
 * Identity helpers for `createAdcpServerFromPlatform` adopters who build their
 * platform as an object literal rather than a class.
 *
 * **The problem they solve:**
 *
 * `createAdcpServerFromPlatform<P extends DecisioningPlatform<any, any>>(platform: P)`
 * infers `P` from the argument, which defeats TypeScript's contextual typing for
 * method parameters inside nested object literals. Without an explicit type annotation,
 * a handler like `syncEventSources: async (req, ctx) => {...}` gets `req: unknown`.
 *
 * These helpers force a concrete `DecisioningPlatform<TConfig, TCtxMeta>` (or
 * per-specialism sub-interface) as the argument type, giving TypeScript the
 * annotation it needs to flow types into nested method bodies:
 *
 * ```ts
 * // Without helper — req: unknown
 * createAdcpServerFromPlatform({
 *   sales: { syncEventSources: async (req, ctx) => { req.event_sources } }
 * }, opts);
 *
 * // With defineSalesPlatform — req: SyncEventSourcesRequest ✓
 * createAdcpServerFromPlatform({
 *   sales: defineSalesPlatform<MyMeta>({
 *     syncEventSources: async (req, ctx) => { req.event_sources }
 *   })
 * }, opts);
 * ```
 *
 * Alternatively, the class pattern with explicit property-type annotations achieves
 * the same result without helpers:
 *
 * ```ts
 * class MySeller implements DecisioningPlatform<Config, MyMeta> {
 *   sales: SalesPlatform<MyMeta> = {
 *     syncEventSources: async (req, ctx) => { req.event_sources } // req typed ✓
 *   };
 * }
 * ```
 *
 * Use whichever pattern fits your codebase.
 *
 * @public
 */

import type { DecisioningPlatform } from './platform';
import type { ComplianceTestingCapabilities } from './capabilities';
import type { Account, AccountStore, ResolveContext } from './account';
import type { AccountReference } from '../../types/tools.generated';
import type { SalesPlatform, SalesCorePlatform, SalesIngestionPlatform } from './specialisms/sales';
import type { AudiencePlatform } from './specialisms/audiences';
import type { SignalsPlatform } from './specialisms/signals';
import type { CreativeBuilderPlatform } from './specialisms/creative';
import type { CreativeAdServerPlatform } from './specialisms/creative-ad-server';
import type { CampaignGovernancePlatform } from './specialisms/campaign-governance';
import type { ContentStandardsPlatform } from './specialisms/content-standards';
import type { BrandRightsPlatform } from './specialisms/brand-rights';
import type { PropertyListsPlatform, CollectionListsPlatform } from './specialisms/lists';

/**
 * Type-level identity for a full `DecisioningPlatform` object literal.
 *
 * Fixes TypeScript's contextual-typing gap when passing an object literal
 * directly to `createAdcpServerFromPlatform`. Wrap your platform object with
 * this helper to get typed `req` and `ctx` parameters in every handler body.
 *
 * @example
 * ```ts
 * import { createAdcpServerFromPlatform, definePlatform } from '@adcp/sdk/server';
 *
 * interface MyMeta { advertiserId: string }
 *
 * const server = createAdcpServerFromPlatform(
 *   definePlatform<{ networkId: string }, MyMeta>({
 *     capabilities: { specialisms: ['sales-non-guaranteed'], ... },
 *     accounts: { resolve: async (ref) => ... },
 *     sales: {
 *       getProducts: async (req, ctx) => {
 *         // req: GetProductsRequest ✓  ctx.account.ctx_metadata: MyMeta ✓
 *       },
 *     },
 *   }),
 *   { name: 'my-seller', version: '1.0.0' }
 * );
 * ```
 */
export function definePlatform<TConfig = unknown, TCtxMeta = Record<string, unknown>>(
  platform: DecisioningPlatform<TConfig, TCtxMeta>
): DecisioningPlatform<TConfig, TCtxMeta> {
  return platform;
}

/**
 * Type-level identity for a `SalesPlatform` sub-object.
 *
 * Use this to type-annotate the `sales` property when building inline rather
 * than with a class. Every handler method (`getProducts`, `createMediaBuy`,
 * `syncEventSources`, etc.) gets its proper typed `req` parameter.
 *
 * @example
 * ```ts
 * import { createAdcpServerFromPlatform, defineSalesPlatform } from '@adcp/sdk/server';
 *
 * interface SocialMeta { advertiserId: string; pixelId: string }
 *
 * const server = createAdcpServerFromPlatform({
 *   capabilities: { specialisms: ['sales-social', 'sales-non-guaranteed'], ... },
 *   accounts: { resolve: async (ref) => ... },
 *   sales: defineSalesPlatform<SocialMeta>({
 *     getProducts: async (req, ctx) => { ... },
 *     createMediaBuy: async (req, ctx) => { ... },
 *     // req is fully typed throughout ✓
 *     syncEventSources: async (req, ctx) => {
 *       const sources = req.event_sources ?? [];  // no cast needed
 *     },
 *   }),
 * }, { name: 'social-seller', version: '1.0.0' });
 * ```
 */
export function defineSalesPlatform<TCtxMeta = Record<string, unknown>>(
  platform: SalesPlatform<TCtxMeta>
): SalesPlatform<TCtxMeta> {
  // Identity helper — return type matches the input parameter type.
  //
  // **Post-#1341 caveat.** `SalesPlatform` methods are now optional
  // individually, so this helper's return type is effectively all-optional
  // even when the adopter passes all five core methods. Adopters claiming
  // a sales specialism with `RequiredPlatformsFor<S>`-narrowed core methods
  // (`sales-guaranteed`, `sales-non-guaranteed`, `sales-broadcast-tv`,
  // `sales-catalog-driven`) need the closed shape on the way out — this
  // helper doesn't preserve it. Two ways to keep the per-specialism type
  // narrowing under #1341:
  //
  //   1. Drop `defineSalesPlatform` and write the platform field with an
  //      explicit `: SalesCorePlatform<Meta> & SalesIngestionPlatform<Meta>`
  //      annotation. The TS compiler flows the contextual type into the
  //      literal and `RequiredPlatformsFor<S>` enforcement holds.
  //   2. Use the new {@link defineSalesCorePlatform} for the core methods
  //      and {@link defineSalesIngestionPlatform} for ingestion methods,
  //      spreading both onto the `sales` field.
  //
  // Pure source-compat for adopters claiming `sales-social` (ingestion-only)
  // who don't need the per-specialism core narrowing — the helper still
  // pins TCtxMeta on the parameter so handler `ctx` is typed correctly.
  return platform;
}

/**
 * Type-level identity for the **core** sales surface — bidding +
 * media-buy lifecycle (`getProducts`, `createMediaBuy`, `updateMediaBuy`,
 * `getMediaBuyDelivery`, `getMediaBuys`). Use when claiming `sales-non-
 * guaranteed` / `sales-guaranteed` / `sales-broadcast-tv` /
 * `sales-catalog-driven` and you want compile-time enforcement of the
 * lifecycle methods without dragging in optional ingestion methods.
 *
 * Pair with {@link defineSalesIngestionPlatform} when also implementing
 * ingestion surfaces (sync_creatives, log_event, etc.) — spread the two
 * onto the platform's `sales` field.
 *
 * @example
 * ```ts
 * sales: { ...defineSalesCorePlatform<MyMeta>({
 *   getProducts: async (req, ctx) => { ... },
 *   createMediaBuy: async (req, ctx) => { ... },
 *   updateMediaBuy: async (id, patch, ctx) => { ... },
 *   getMediaBuyDelivery: async (filter, ctx) => { ... },
 *   getMediaBuys: async (req, ctx) => { ... },
 * }) },
 * ```
 */
export function defineSalesCorePlatform<TCtxMeta = Record<string, unknown>>(
  platform: SalesCorePlatform<TCtxMeta>
): SalesCorePlatform<TCtxMeta> {
  return platform;
}

/**
 * Type-level identity for the **ingestion** sales surface — sync surfaces
 * (`syncCreatives`, `syncCatalogs`, `syncEventSources`, `logEvent`) +
 * read/feedback (`listCreativeFormats`, `listCreatives`,
 * `providePerformanceFeedback`). Walled-garden specialisms whose value
 * surface is asset push (Meta CAPI, Snap CAPI, retail-media catalogs)
 * use this without claiming the core media-buy lifecycle. Every method
 * is optional individually — implement what your specialism's storyboard
 * exercises.
 *
 * Use this when claiming `sales-social` (no `sales-non-guaranteed`)
 * or composing `audience-sync` ingestion onto a non-media-buy seller.
 * Adopters who also accept inbound media buys spread
 * {@link defineSalesCorePlatform}'s output alongside.
 *
 * @example
 * ```ts
 * // Pure sales-social adopter — no media buys, just events + creatives.
 * sales: defineSalesIngestionPlatform<SocialMeta>({
 *   syncCreatives: async (creatives, ctx) => { ... },
 *   syncEventSources: async (req, ctx) => { ... },
 *   logEvent: async (req, ctx) => { ... },
 * }),
 * ```
 */
export function defineSalesIngestionPlatform<TCtxMeta = Record<string, unknown>>(
  platform: SalesIngestionPlatform<TCtxMeta>
): SalesIngestionPlatform<TCtxMeta> {
  return platform;
}

/**
 * Type-level identity for an `AudiencePlatform` sub-object.
 *
 * Use when the `audiences` field is built inline. Ensures `audiences` and
 * `audienceIds` parameters are typed rather than inferred as `unknown`.
 *
 * @example
 * ```ts
 * audiences: defineAudiencePlatform<SocialMeta>({
 *   syncAudiences: async (audiences, ctx) => {
 *     // audiences: Audience[] ✓  ctx.account.ctx_metadata: SocialMeta ✓
 *   },
 *   pollAudienceStatuses: async (audienceIds, ctx) => { ... },
 * }),
 * ```
 */
export function defineAudiencePlatform<TCtxMeta = Record<string, unknown>>(
  platform: AudiencePlatform<TCtxMeta>
): AudiencePlatform<TCtxMeta> {
  return platform;
}

/**
 * Type-level identity for a `SignalsPlatform` sub-object.
 *
 * @example
 * ```ts
 * signals: defineSignalsPlatform<SignalsMeta>({
 *   getSignals: async (req, ctx) => { ... },
 *   activateSignal: async (req, ctx) => { ... },
 * }),
 * ```
 */
export function defineSignalsPlatform<TCtxMeta = Record<string, unknown>>(
  platform: SignalsPlatform<TCtxMeta>
): SignalsPlatform<TCtxMeta> {
  return platform;
}

/**
 * Type-level identity for a `CreativeBuilderPlatform` sub-object.
 *
 * @example
 * ```ts
 * creative: defineCreativeBuilderPlatform<CreativeMeta>({
 *   buildCreative: async (req, ctx) => { ... },
 * }),
 * ```
 */
export function defineCreativeBuilderPlatform<TCtxMeta = Record<string, unknown>>(
  platform: CreativeBuilderPlatform<TCtxMeta>
): CreativeBuilderPlatform<TCtxMeta> {
  return platform;
}

/**
 * Type-level identity for a `CreativeAdServerPlatform` sub-object.
 */
export function defineCreativeAdServerPlatform<TCtxMeta = Record<string, unknown>>(
  platform: CreativeAdServerPlatform<TCtxMeta>
): CreativeAdServerPlatform<TCtxMeta> {
  return platform;
}

/**
 * Type-level identity for a `CampaignGovernancePlatform` sub-object.
 */
export function defineCampaignGovernancePlatform<TCtxMeta = Record<string, unknown>>(
  platform: CampaignGovernancePlatform<TCtxMeta>
): CampaignGovernancePlatform<TCtxMeta> {
  return platform;
}

/**
 * Type-level identity for a `ContentStandardsPlatform` sub-object.
 */
export function defineContentStandardsPlatform<TCtxMeta = Record<string, unknown>>(
  platform: ContentStandardsPlatform<TCtxMeta>
): ContentStandardsPlatform<TCtxMeta> {
  return platform;
}

/**
 * Type-level identity for a `PropertyListsPlatform` sub-object.
 */
export function definePropertyListsPlatform<TCtxMeta = Record<string, unknown>>(
  platform: PropertyListsPlatform<TCtxMeta>
): PropertyListsPlatform<TCtxMeta> {
  return platform;
}

/**
 * Type-level identity for a `CollectionListsPlatform` sub-object.
 */
export function defineCollectionListsPlatform<TCtxMeta = Record<string, unknown>>(
  platform: CollectionListsPlatform<TCtxMeta>
): CollectionListsPlatform<TCtxMeta> {
  return platform;
}

/**
 * Type-level identity for a `BrandRightsPlatform` sub-object.
 */
export function defineBrandRightsPlatform<TCtxMeta = Record<string, unknown>>(
  platform: BrandRightsPlatform<TCtxMeta>
): BrandRightsPlatform<TCtxMeta> {
  return platform;
}

/**
 * Type-level identity for a full `DecisioningPlatform` that wires
 * `comply_test_controller`. Requires `capabilities.compliance_testing`
 * to be present in the platform object, enforcing the cap/adapter
 * pairing at compile time.
 *
 * When the returned platform is passed to `createAdcpServerFromPlatform`,
 * `RequiredOptsFor<P>` resolves to require `complyTest` in opts — so
 * both halves of the invariant are enforced without runtime-only feedback.
 *
 * @example
 * ```ts
 * import {
 *   createAdcpServerFromPlatform,
 *   definePlatformWithCompliance,
 * } from '@adcp/sdk/server';
 *
 * const server = createAdcpServerFromPlatform(
 *   definePlatformWithCompliance<Config, Meta>({
 *     capabilities: {
 *       specialisms: ['sales-guaranteed'],
 *       compliance_testing: {}, // required by this helper ✓
 *     },
 *     accounts: { resolve: async (ref) => ... },
 *     sales: { ... },
 *   }),
 *   {
 *     name: 'my-seller',
 *     version: '1.0.0',
 *     complyTest: { seed: { product: ... } }, // required by RequiredOptsFor<P> ✓
 *   }
 * );
 * ```
 */
export function definePlatformWithCompliance<TConfig = unknown, TCtxMeta = Record<string, unknown>>(
  platform: DecisioningPlatform<TConfig, TCtxMeta> & {
    capabilities: { compliance_testing: ComplianceTestingCapabilities };
  }
): DecisioningPlatform<TConfig, TCtxMeta> & {
  capabilities: { compliance_testing: ComplianceTestingCapabilities };
} {
  return platform;
}

/**
 * Type-level identity for an `AccountStore` sub-object.
 *
 * Forces a concrete `AccountStore<TCtxMeta>` annotation on the argument so
 * TypeScript flows types into `resolve` / `upsert` / `getAccountFinancials`
 * handler bodies. Without this, an inline `accounts: { resolve: ... }` literal
 * gets `ref: AccountReference | undefined` typed but `ctx_metadata` returns
 * fall back to `Record<string, unknown>` — `defineAccountStore<MyMeta>(...)`
 * pins the metadata type at construction.
 *
 * @example
 * ```ts
 * accounts: defineAccountStore<MyMeta>({
 *   resolve: async (ref) => {
 *     if (!ref) return null;
 *     // ctx_metadata: MyMeta ✓
 *     return { id: ..., ctx_metadata: { advertiserId: '...' } };
 *   },
 * }),
 * ```
 */
export function defineAccountStore<TCtxMeta = Record<string, unknown>>(
  store: AccountStore<TCtxMeta>
): AccountStore<TCtxMeta> {
  return store;
}

/**
 * Build an `AccountStore` whose `resolve(undefined, ctx)` is guaranteed to
 * return a non-null `Account<TCtxMeta>` — fixes the no-account-tool footgun
 * where `preview_creative` / `list_creative_formats` /
 * `provide_performance_feedback` / `tasks_get` arrive without an `account`
 * field on the wire and the dispatcher hands the typed handler a
 * `ctx.account === undefined`.
 *
 * Pass a `noAccountFallback` Account (the publisher-wide / single-tenant
 * singleton appropriate for catalog lookups and feedback intake) and a
 * `resolve` for the account-bearing case (`ref` is non-undefined). The
 * helper composes them: if `ref` is undefined, the fallback wins; otherwise
 * the inner resolver runs. The composed store is a normal
 * `AccountStore<TCtxMeta>` — no separate type, no escape hatch needed.
 *
 * Why this exists rather than per-tool ctx narrowing: `RequestContext.account`
 * is non-optional by design (90% of tools carry `account` on the wire and
 * type-narrowing every handler would force optional-chaining everywhere).
 * No-account tools are the long-tail exception — this helper makes the
 * typed-handler invariant explicit at the AccountStore construction site.
 *
 * Adopters who don't claim no-account specialisms (or who don't implement
 * `previewCreative` / `listCreativeFormats` / `providePerformanceFeedback`)
 * keep using `defineAccountStore` with their own `resolve` and don't need
 * this helper.
 *
 * @example
 * ```ts
 * accounts: accountStoreWithNoAccountFallback<MyMeta>({
 *   noAccountFallback: {
 *     id: 'publisher-wide',
 *     name: 'Publisher (no-account fallback)',
 *     status: 'active',
 *     ctx_metadata: { workspace_id: 'default' },
 *   },
 *   resolve: async (ref, ctx) => {
 *     // ref is guaranteed non-undefined here — TS flows the narrowing
 *     return await this.db.findById(ref.account_id);
 *   },
 * }),
 * ```
 */
export function accountStoreWithNoAccountFallback<TCtxMeta = Record<string, unknown>>(
  spec: Omit<AccountStore<TCtxMeta>, 'resolve'> & {
    /** Singleton Account returned when `accounts.resolve(undefined)` fires. Required. */
    noAccountFallback: Account<TCtxMeta>;
    /**
     * Resolve a non-undefined buyer reference. The framework's no-account
     * branch is intercepted by `noAccountFallback`, so this resolver only
     * runs for `ref !== undefined`.
     */
    resolve: (ref: AccountReference, ctx?: ResolveContext) => Promise<Account<TCtxMeta> | null>;
  }
): AccountStore<TCtxMeta> {
  const { noAccountFallback, resolve, ...rest } = spec;
  return {
    ...rest,
    resolve: async (ref, ctx) => {
      if (ref === undefined) return noAccountFallback;
      return await resolve(ref, ctx);
    },
  };
}
