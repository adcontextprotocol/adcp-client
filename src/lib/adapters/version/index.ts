/**
 * Registry of per-version request adapters, keyed by target AdCP version string.
 *
 * `resolveAdapterKey` maps a (clientVersion, sellerCaps) pair to the adapter
 * key whose adapters should be applied. `getVersionAdapter` looks up the
 * per-tool adapter for that key. The dispatch in `SingleAgentClient` calls
 * both; tools without a registered adapter for the resolved key pass through
 * unchanged.
 *
 * Add a new version transition by:
 *   1. Create a `version/<target>/` directory with per-tool adapter modules.
 *   2. Collect them in `version/<target>/index.ts` as a `ReadonlyArray<VersionAdapter>`.
 *   3. Register below.
 *   4. Add tests to the conformance suite.
 */

import { shouldOmit31Fields } from '../../utils/adcp-version-config';
import type { VersionAdapter } from './types';
import { v30Adapters } from './3.0/index';

export type { VersionAdapter, VersionDrift } from './types';

const REGISTRY = new Map<string, ReadonlyMap<string, VersionAdapter>>();

function register(version: string, adapters: ReadonlyArray<VersionAdapter>): void {
  REGISTRY.set(version, new Map(adapters.map(a => [a.toolName, a])));
}

register('3.0', v30Adapters);

/**
 * Look up the version adapter for a given (adapterKey, toolName) pair.
 * Returns `undefined` when no adapter is registered — caller passes through.
 */
export function getVersionAdapter(adapterKey: string, toolName: string): VersionAdapter | undefined {
  return REGISTRY.get(adapterKey)?.get(toolName);
}

/**
 * Resolve the adapter key for the current (clientVersion, sellerCaps) pair.
 * Returns `undefined` when no adaptation is needed (both sides speak the same
 * or a compatible version). Returns `'3.0'` when either the client is pinned
 * below 3.1 or the seller does not advertise 3.1 support.
 */
export function resolveAdapterKey(
  clientVersion: string | undefined,
  caps: { supportedVersions?: string[]; buildVersion?: string } | undefined
): string | undefined {
  if (shouldOmit31Fields(clientVersion, caps)) return '3.0';
  return undefined;
}

/**
 * Names of tools registered for a given adapter key.
 * Used by the conformance test suite as the authoritative list.
 */
export function listVersionAdapterTools(adapterKey: string): string[] {
  return [...(REGISTRY.get(adapterKey)?.keys() ?? [])];
}
