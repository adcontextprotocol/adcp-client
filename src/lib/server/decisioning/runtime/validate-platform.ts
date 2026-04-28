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
};

export class PlatformConfigError extends Error {
  readonly name = 'PlatformConfigError' as const;
  constructor(message: string) {
    super(message);
  }
}

/**
 * Dual-method tool pairs. Today's SDK supports the two tools whose
 * generated response types ARE response unions including a Submitted arm:
 * `create_media_buy` (CreateMediaBuyResponse = Success | Error | Submitted)
 * and `sync_creatives` (SyncCreativesResponse = same shape).
 *
 * **Why only 2 of 6.** The spec ships Submitted arms in
 * `core/async-response-data.json` for SIX tools (`create_media_buy`,
 * `sync_creatives`, `update_media_buy`, `build_creative`, `sync_catalogs`,
 * `get_products`) — but only `create_media_buy` and `sync_creatives` roll
 * the Submitted arm into their per-tool `xxx-response.json` `oneOf`. The
 * other 4 have inconsistent response schemas: their per-tool wire
 * response is `Success | Error` (no Submitted), even though the
 * `xxx-async-response-submitted.json` schema files exist and are
 * referenced from `core/async-response-data.json`.
 *
 * This is a SPEC inconsistency, not a codegen bug. SDK codegen reads
 * each tool's `xxx-response.json` `oneOf` and produces a faithful TS
 * union — for the 2 tools where Submitted is in the `oneOf`, the union
 * includes it; for the 4 where it isn't, the union is narrower. Adding
 * dual-method support in the SDK without the spec fix would mean the
 * SDK accepts a Submitted envelope that wire-validating receivers
 * (which check against the per-tool response schema) would reject.
 *
 * Filed upstream as adcontextprotocol/adcp#3392 — proposes adding the
 * Submitted arm to the per-tool `oneOf` for the 4 missing tools.
 * When it lands, SDK ships `*Task` methods for `update_media_buy`,
 * `build_creative`, `sync_catalogs`, `get_products`. Until then,
 * long-form flows on those tools surface via `publishStatusChange` on
 * the appropriate resource type (`proposal` / `media_buy` / `creative`).
 */
const DUAL_METHOD_PAIRS: Record<string, ReadonlyArray<readonly [string, string]>> = {
  sales: [
    ['createMediaBuy', 'createMediaBuyTask'],
    ['syncCreatives', 'syncCreativesTask'],
  ],
  creative: [['syncCreatives', 'syncCreativesTask']],
};

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

  // 2. Dual-method exactly-one enforcement on each spec-HITL tool
  for (const [field, pairs] of Object.entries(DUAL_METHOD_PAIRS)) {
    const specialism = (platform as unknown as Record<string, unknown>)[field];
    if (specialism == null) continue;
    const methods = specialism as Record<string, unknown>;
    for (const [syncName, taskName] of pairs) {
      const hasSync = typeof methods[syncName] === 'function';
      const hasTask = typeof methods[taskName] === 'function';
      if (hasSync && hasTask) {
        errors.push(
          `${field}.${syncName} and ${field}.${taskName} are both defined. ` +
            `Each spec-HITL tool requires exactly one method shape per platform — ` +
            `pick sync (${syncName}) for "buyer gets resource ID immediately" workflows OR ` +
            `task (${taskName}) for HITL workflows where buyer cannot get the resource until human acts.`
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new PlatformConfigError(`DecisioningPlatform configuration is incomplete:\n  - ${errors.join('\n  - ')}`);
  }
}
