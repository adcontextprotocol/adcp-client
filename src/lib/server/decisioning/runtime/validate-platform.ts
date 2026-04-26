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
  'sales-non-guaranteed': ['sales'],
  'creative-template': ['creative'],
  'creative-generative': ['creative'],
  'audience-sync': ['audiences'],
};

export class PlatformConfigError extends Error {
  readonly name = 'PlatformConfigError' as const;
  constructor(message: string) {
    super(message);
  }
}

/**
 * Dual-method tool pairs. Each spec-HITL-eligible tool exposes both a sync
 * variant (`xxx`) and a HITL variant (`xxxTask`). Exactly one must be defined
 * per pair when the specialism requires the tool; defining both is an error.
 */
const DUAL_METHOD_PAIRS: Record<string, ReadonlyArray<readonly [string, string]>> = {
  sales: [
    ['getProducts', 'getProductsTask'],
    ['createMediaBuy', 'createMediaBuyTask'],
    ['updateMediaBuy', 'updateMediaBuyTask'],
    ['syncCreatives', 'syncCreativesTask'],
  ],
  creative: [
    ['buildCreative', 'buildCreativeTask'],
    ['syncCreatives', 'syncCreativesTask'],
  ],
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
