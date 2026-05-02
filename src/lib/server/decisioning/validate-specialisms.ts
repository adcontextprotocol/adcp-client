/**
 * Runtime validation for specialism→required-tools coverage.
 *
 * When an adopter declares a specialism in `capabilities.specialisms[]`, the
 * AdCP spec implies the agent supports every tool in that specialism's
 * required-tool list (per `manifest.specialisms[*].required_tools` —
 * `SPECIALISM_REQUIRED_TOOLS` in `manifest.generated.ts`). This module checks
 * that the adopter's platform object exposes a method matching every required
 * tool, and emits actionable warnings (or throws under strict mode) when
 * something's missing.
 *
 * The check is **method-presence anywhere on the platform**, not method-on-
 * specific-field. Required tools can span platform fields (`sync_accounts`
 * lives on `accounts`, not on the specialism's primary platform field), and
 * the SDK doesn't enforce a 1:1 specialism→field mapping. The looser check
 * catches the common adopter mistake (forgot to implement) without
 * false-positives on legitimate layout choices.
 *
 * Tracked: adcp-client#1192 (manifest adoption) → #1299 (stage 3).
 *
 * Companion to the build-time type-check fixture at
 * `src/lib/server/decisioning/specialism-required-tools.type-checks.ts`,
 * which catches the inverse failure mode (SDK's hand-maintained platform
 * interfaces drifting away from manifest's required-tools contract).
 */

import { SPECIALISM_REQUIRED_TOOLS } from '../../types/manifest.generated';

/**
 * Convert a snake_case tool name to its expected camelCase platform method
 * name. The transform is mechanical — every required tool in 3.0.4 follows
 * this convention. If a future spec introduces a tool whose canonical method
 * name diverges (e.g., the kebab segment maps to an acronym), add an
 * override here rather than reaching for a more elaborate mapping table.
 */
export function toolNameToMethodName(tool: string): string {
  return tool.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

interface ValidatorIssue {
  specialism: string;
  tool: string;
  method: string;
}

/**
 * Walk the platform object's top-level fields and check whether any field
 * exposes a callable property matching `methodName`. Returns true on first
 * match. The platform layout is adopter-controlled — we look across every
 * field rather than mapping tool→field upfront.
 */
function hasMethodAnywhere(platform: unknown, methodName: string): boolean {
  if (!platform || typeof platform !== 'object') return false;
  for (const value of Object.values(platform as Record<string, unknown>)) {
    if (value && typeof value === 'object') {
      const method = (value as Record<string, unknown>)[methodName];
      if (typeof method === 'function') return true;
    }
  }
  return false;
}

/**
 * Validate that `platform` exposes a method for every required tool of every
 * declared specialism. Returns the list of missing (specialism, tool, method)
 * triples. Callers decide whether to warn or throw — `createAdcpServer`
 * defaults to console.warn for ergonomic dev feedback; opt in via the
 * `strictSpecialismValidation` config flag to escalate.
 *
 * Specialisms not present in `SPECIALISM_REQUIRED_TOOLS` (preview-only or
 * not yet enumerated by the manifest) are silently passed — the manifest is
 * the source of truth, and a missing entry there means the spec hasn't yet
 * formalized the required tools for that specialism.
 */
export function validateSpecialismRequiredTools(
  platform: unknown,
  specialisms: readonly string[] | undefined
): ValidatorIssue[] {
  if (!specialisms || specialisms.length === 0) return [];
  const issues: ValidatorIssue[] = [];
  for (const specialism of specialisms) {
    const required = (SPECIALISM_REQUIRED_TOOLS as Record<string, readonly string[] | undefined>)[specialism];
    if (!required) continue;
    for (const tool of required) {
      const method = toolNameToMethodName(tool);
      if (!hasMethodAnywhere(platform, method)) {
        issues.push({ specialism, tool, method });
      }
    }
  }
  return issues;
}

/**
 * Format a single issue as a human-readable warning line. The format names
 * the specialism, the missing tool, and the method an adopter should
 * implement, so the dev fix is obvious from the log.
 */
export function formatSpecialismIssue(issue: ValidatorIssue): string {
  return (
    `[adcp/server] specialism '${issue.specialism}' requires tool '${issue.tool}' ` +
    `but no platform field exposes a '${issue.method}' method. ` +
    `Either implement the method, drop the specialism from capabilities.specialisms, ` +
    `or pass strictSpecialismValidation: false to silence (not recommended — ` +
    `naive AdCP buyers will hit runtime errors when they call the unsupported tool).`
  );
}
