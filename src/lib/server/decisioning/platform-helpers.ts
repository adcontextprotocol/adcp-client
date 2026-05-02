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
import type { SalesPlatform } from './specialisms/sales';
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
