/**
 * Runtime validation that a `DecisioningPlatform` impl matches its
 * `capabilities.specialisms[]` declaration.
 *
 * Compile-time, `RequiredPlatformsFor<S>` enforces this in TypeScript adopter
 * code. Untyped JS callers, downstream packages with relaxed `tsconfig`, and
 * Python-port adopters running this through bindings need a runtime gate.
 *
 * Mirrors the v1.0 specialism × interface mapping in
 * `src/lib/server/decisioning/platform.ts`.
 *
 * @public
 */

import type { DecisioningPlatform } from '../platform';
import type { AdCPSpecialism } from '../../../types/tools.generated';

// Sales specialisms require channels + pricingModels on capabilities because
// buyers read those fields from get_adcp_capabilities to know what the seller
// trades in. Signals/governance/creative-only platforms legitimately omit them
// (hence the fields are optional on DecisioningCapabilities), but a media-buy
// platform serving an empty or absent channels list is a mis-configured agent.
const SALES_SPECIALISMS = new Set<AdCPSpecialism>([
  'sales-non-guaranteed',
  'sales-guaranteed',
  'sales-broadcast-tv',
  'sales-social',
  'sales-catalog-driven',
  'sales-proposal-mode',
]);

const SPECIALISM_REQUIREMENTS: Partial<Record<AdCPSpecialism, ReadonlyArray<keyof DecisioningPlatform>>> = {
  // All sales-* specialisms share the SalesPlatform interface. Adopters
  // implement `sales` once; the specialism enum picks which buyer-side
  // storyboard the agent is validated against. Wired here per the AdCP 3.0
  // GA enum; preview specialisms (sales-streaming-tv, sales-exchange,
  // sales-retail-media) get added when they land in `AdCPSpecialism`.
  'sales-non-guaranteed': ['sales'],
  'sales-guaranteed': ['sales'],
  'sales-broadcast-tv': ['sales'],
  'sales-social': ['sales'],
  'sales-catalog-driven': ['sales'],
  'sales-proposal-mode': ['sales'],
  // Creative specialisms share the CreativeXxxPlatform field name; adopters
  // pick the right archetype (template / generative / ad-server) at
  // construction time.
  'creative-template': ['creative'],
  'creative-generative': ['creative'],
  'creative-ad-server': ['creative'],
  // Audience sync is a single specialism with a single platform interface.
  'audience-sync': ['audiences'],
  // Signal specialisms — both share the SignalsPlatform interface.
  // Marketplace = third-party data brokers; owned = first-party providers.
  'signal-marketplace': ['signals'],
  'signal-owned': ['signals'],
  // Campaign governance — today's two specialisms share one platform
  // interface; consolidates to `campaign-governance` when adcp#3329 lands.
  'governance-spend-authority': ['campaignGovernance'],
  'governance-delivery-monitor': ['campaignGovernance'],
  // Property + collection list publishing.
  'property-lists': ['propertyLists'],
  'collection-lists': ['collectionLists'],
  // Content standards — brand-safety / policy compliance enforcement.
  'content-standards': ['contentStandards'],
  // Brand-rights — identity discovery + licensing for branded inventory.
  // 3 of 5 wire tools wire through `brandRights`; the other 2
  // (`update_rights`, `creative_approval`) await AdcpToolMap landing
  // and stay on the merge-seam path until then.
  'brand-rights': ['brandRights'],
};

export class PlatformConfigError extends Error {
  readonly name = 'PlatformConfigError' as const;
  constructor(message: string) {
    super(message);
  }
}

// Note on HITL tools: the v6 unified shape collapses sync/HITL into a
// single method per tool whose return type is `Success | TaskHandoff<Success>`.
// Adopters branch in the body and call `ctx.handoffToTask(fn)` to defer
// to a background task. The framework detects the handoff marker at the
// dispatch seam — there's no exactly-one validation needed because the
// shape is the same regardless of which path the adopter takes.
//
// This applies to `create_media_buy` and `sync_creatives` today (the 2
// spec-listed tools whose per-tool response oneOf includes the Submitted
// arm). When adcontextprotocol/adcp#3392 lands, the same shape extends
// to `update_media_buy`, `build_creative`, `sync_catalogs`, `get_products`.

export function validatePlatform(platform: DecisioningPlatform): void {
  const claimed = platform.capabilities?.specialisms ?? [];
  const errors: string[] = [];

  // 1. Specialism declarations match required interfaces
  for (const specialism of claimed) {
    const required = SPECIALISM_REQUIREMENTS[specialism];
    if (!required) continue; // forward-compat for unknown specialisms
    for (const field of required) {
      if (platform[field] == null) {
        errors.push(`capabilities.specialisms claims '${specialism}'; platform.${String(field)} is missing`);
      }
    }
  }

  // 2. Media-buy platforms require channels + pricingModels on capabilities.
  // These fields are optional on DecisioningCapabilities so non-media-buy
  // platforms (signals, governance, creative-only) can omit them, but a
  // sales platform that omits them will emit a broken get_adcp_capabilities
  // response that buyers cannot interpret.
  const claimedSales = claimed.filter(s => SALES_SPECIALISMS.has(s));
  if (claimedSales.length > 0) {
    if (platform.capabilities?.channels == null) {
      errors.push(
        `capabilities.channels is required for media-buy platforms (claimed: ${claimedSales.join(', ')})`
      );
    }
    if (platform.capabilities?.pricingModels == null) {
      errors.push(
        `capabilities.pricingModels is required for media-buy platforms (claimed: ${claimedSales.join(', ')})`
      );
    }
  }

  if (errors.length > 0) {
    throw new PlatformConfigError(`DecisioningPlatform configuration is incomplete:\n  - ${errors.join('\n  - ')}`);
  }
}
