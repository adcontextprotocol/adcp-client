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

export function validatePlatform(platform: DecisioningPlatform): void {
  const claimed = platform.capabilities?.specialisms ?? [];
  const missing: string[] = [];
  for (const specialism of claimed) {
    const required = SPECIALISM_REQUIREMENTS[specialism];
    if (!required) continue; // unknown specialism — framework's runtime gate is a no-op (forward-compat)
    for (const field of required) {
      if (platform[field] == null) {
        missing.push(`capabilities.specialisms claims '${specialism}'; platform.${String(field)} is missing`);
      }
    }
  }
  if (missing.length > 0) {
    throw new PlatformConfigError(`DecisioningPlatform configuration is incomplete:\n  - ${missing.join('\n  - ')}`);
  }
}
