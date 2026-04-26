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
  // pick the right archetype (template vs generative) at construction time.
  'creative-template': ['creative'],
  'creative-generative': ['creative'],
  // Audience sync is a single specialism with a single platform interface.
  'audience-sync': ['audiences'],
  // Signal specialisms — both share the SignalsPlatform interface.
  // Marketplace = third-party data brokers; owned = first-party providers.
  'signal-marketplace': ['signals'],
  'signal-owned': ['signals'],
};

export class PlatformConfigError extends Error {
  readonly name = 'PlatformConfigError' as const;
  constructor(message: string) {
    super(message);
  }
}

/**
 * Dual-method tool pairs. Only the two spec-HITL-eligible tools that have
 * `Submitted` arms in their wire response unions today: `create_media_buy`
 * and `sync_creatives`. Adopters implement EXACTLY ONE per pair when the
 * specialism uses the tool; defining both is an error.
 *
 * `get_products`, `update_media_buy`, `build_creative`, and `sync_audiences`
 * are sync-only — their wire response unions don't define Submitted arms.
 * Long-running flows for those tools surface via `publishStatusChange` on
 * the appropriate resource type (audience, plan, proposal, etc.).
 *
 * If you want HITL on a sync-only tool, file an issue against
 * adcontextprotocol/adcp to add a Submitted arm to its response union.
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
