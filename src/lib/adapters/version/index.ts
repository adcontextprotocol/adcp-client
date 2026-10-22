/**
 * Registry of per-version adapters, keyed by the older AdCP release of each
 * consecutive minor pair (`'3.1'` holds the 3.2 ↔ 3.1 adapters, `'3.0'` the
 * 3.1 ↔ 3.0 adapters).
 *
 * `negotiateAdcpRelease` picks the wire release for a seller.
 * `convertRequest` / `convertResponse` then chain the adapters and the
 * schema projection across every step between the client's release and the
 * wire release. `resolveAdapterKey` remains for sellers whose release cannot
 * be negotiated (synthetic capabilities), where only the 3.0 adapters apply.
 *
 * Add a new version transition by:
 *   1. Create a `version/<target>/` directory with per-tool adapter modules
 *      for renames and moves. Pure additions need no adapter: the schema
 *      projection removes and reports them.
 *   2. Collect them in `version/<target>/index.ts` as a `ReadonlyArray<VersionAdapter>`.
 *   3. Register below.
 *   4. Add tests to the conformance suite.
 */

import { shouldOmit31Fields } from '../../utils/adcp-version-config';
import { isMutatingTask } from '../../utils/idempotency';
import type { VersionAdapter } from './types';
import { v30Adapters } from './3.0/index';
import { v31Adapters } from './3.1/index';
import {
  convertRequestToRelease,
  convertResponseFromRelease,
  type AccountIdentityDowngrade,
  type RequestTranslation,
  type ResponseTranslation,
} from './translate';

export type { VersionAdapter, VersionDrift } from './types';
export type { AccountIdentityDowngrade, RequestTranslation, ResponseTranslation, TranslationStep } from './translate';
export { translationSteps } from './translate';
export {
  negotiateAdcpRelease,
  isNegotiationFailure,
  parseAdcpRelease,
  adcpMinorLine,
  compareAdcpMinorLines,
} from './negotiate';
export type { NegotiatedAdcpRelease, AdcpNegotiationFailure, AdcpNegotiationSource } from './negotiate';
export { projectToolPayload, releaseDefinesTool } from './schema-projection';
export type { ProjectionDrop, ProjectionResult } from './schema-projection';

const REGISTRY = new Map<string, ReadonlyMap<string, VersionAdapter>>();

function register(version: string, adapters: ReadonlyArray<VersionAdapter>): void {
  REGISTRY.set(version, new Map(adapters.map(a => [a.toolName, a])));
}

register('3.0', v30Adapters);
register('3.1', v31Adapters);

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
  caps: { supportedVersions?: string[]; buildVersion?: string; _raw?: Record<string, unknown> } | undefined
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

/**
 * Convert a request built for `fromVersion` (the client's release) down to
 * the negotiated wire release `toVersion`.
 */
export function convertRequest<T>(
  toolName: string,
  params: T,
  options: {
    fromVersion: string;
    toVersion: string;
    accountIdentity?: AccountIdentityDowngrade;
    /** Defaults to `isMutatingTask(toolName)`. */
    mutating?: boolean;
  }
): RequestTranslation<T> {
  return convertRequestToRelease(toolName, params, {
    fromVersion: options.fromVersion,
    toVersion: options.toVersion,
    accountIdentity: options.accountIdentity ?? 'refuse',
    mutating: options.mutating ?? isMutatingTask(toolName),
    adapters: getVersionAdapter,
  });
}

/**
 * Convert a response served at the wire release `fromVersion` up to the
 * client's release `toVersion`.
 */
export function convertResponse<T>(
  toolName: string,
  data: T,
  options: { fromVersion: string; toVersion: string }
): ResponseTranslation<T> {
  return convertResponseFromRelease(toolName, data, { ...options, adapters: getVersionAdapter });
}
