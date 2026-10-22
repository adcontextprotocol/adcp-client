/**
 * Chained conversion between AdCP minor releases.
 *
 * Application code builds requests in the shape of the client's own release
 * and reads responses in that shape. When the negotiated wire release is
 * older, requests are converted down one minor at a time (3.2 → 3.1 → 3.0)
 * and responses are converted back up the same steps in reverse.
 *
 * Each downward step runs the step's hand-written adapter (renames and moves)
 * and then the schema projection, which removes whatever the older release
 * cannot express and reports it. Upward steps run hand-written adapters only:
 * a field an older seller sends that the newer release dropped is left for
 * the caller rather than silently discarded.
 */

import { adcpMinorLine, parseAdcpRelease } from './negotiate';
import { projectToolPayload, type ProjectionDrop } from './schema-projection';
import type { VersionAdapter, VersionDrift } from './types';

/**
 * How to convert a request whose account key uses fields the target release
 * cannot express (AdCP 3.2 added `operator_unit`, `currency` and `timezone`
 * to the account natural key, and `countries` to brand references).
 *
 * - `'refuse'`: fail the call before it is sent.
 * - `'reduce'`: send the older key. Buyer keys that differ only in the new
 *   fields share one seller account. Every reduced field is reported as an
 *   `account_identity_reduced` drift entry so the buyer can detect it.
 */
export type AccountIdentityDowngrade = 'refuse' | 'reduce';

export interface TranslationStep {
  /** Release the step converts from (downward) / to (upward). */
  upper: string;
  /** Release the step converts to (downward) / from (upward). Also the adapter key. */
  lower: string;
  /** Registry key for the step's hand-written adapters, e.g. `'3.1'`. */
  key: string;
}

export interface RequestTranslation<T = unknown> {
  params: T;
  drifts: VersionDrift[];
  /**
   * Account-identity fields the target release cannot express, with the
   * release line that introduced each. Under `'refuse'` the caller must not
   * send the request when this is non-empty.
   */
  identityFields: Array<{ path: string; introducedIn: string }>;
  /**
   * Fields of a mutating request the target release cannot express and whose
   * loss would change what the seller does. The caller must not send the
   * request when this is non-empty.
   */
  refusedFields: Array<{ path: string; introducedIn: string }>;
}

export interface ResponseTranslation<T = unknown> {
  data: T;
  drifts: VersionDrift[];
}

type AdapterLookup = (key: string, toolName: string) => VersionAdapter | undefined;

/**
 * Steps between two releases, newest first. Empty when both are on the same
 * minor line or `lower` is not older than `upper`.
 */
export function translationSteps(upperVersion: string, lowerVersion: string): TranslationStep[] {
  const upper = parseAdcpRelease(upperVersion);
  const lower = parseAdcpRelease(lowerVersion);
  if (!upper || !lower || upper.major !== lower.major || upper.minor <= lower.minor) return [];
  const steps: TranslationStep[] = [];
  for (let minor = upper.minor; minor > lower.minor; minor--) {
    const key = `${upper.major}.${minor - 1}`;
    steps.push({
      upper: minor === upper.minor ? upperVersion : `${upper.major}.${minor}`,
      lower: minor - 1 === lower.minor ? lowerVersion : key,
      key,
    });
  }
  return steps;
}

const IDENTITY_FIELD_PATTERNS = [
  // Account references anywhere in a request (`account`, `accounts[n]`,
  // `filters.accounts[n]`), including sync_accounts rows. AdCP 3.2 brand
  // country sets are part of the key inside an account reference.
  /(?:^|[.\]])accounts?(?:\[\d+\])?\.(?:operator_unit|currency|timezone|brand\.countries)$/,
  // ...and scope a rights licensee.
  /^(?:buyer|buyer_brand)\.countries$/,
];

function isIdentityDrop(drop: ProjectionDrop): boolean {
  return drop.kind === 'field' && IDENTITY_FIELD_PATTERNS.some(pattern => pattern.test(drop.path));
}

/**
 * Fields a mutation may lose without changing what the seller commits to:
 * labels and hints. Every other field a mutation would lose limits or
 * changes the operation (a budget cap, a targeting exclusion, a bidding
 * mode, an update), so the request is refused rather than sent without it.
 */
const DESCRIPTIVE_FIELD_PATTERNS = [
  /^(?:name|opportunity|governance_context)$/,
  /^brand\.countries$/,
  /(?:^|\.)pacing$/,
  /\.creative_assignments\[\d+\]\.(?:rotation_mode|group_id|sequence_position)$/,
];

/** Updates: a lost field is a requested change that would not happen. */
const UPDATE_TOOLS = new Set(['update_media_buy']);

function isDescriptiveDrop(toolName: string, drop: ProjectionDrop): boolean {
  if (UPDATE_TOOLS.has(toolName)) return false;
  return drop.kind === 'field' && DESCRIPTIVE_FIELD_PATTERNS.some(pattern => pattern.test(drop.path));
}

function droppedDrift(toolName: string, drops: ProjectionDrop[], step: TranslationStep): VersionDrift {
  const paths = drops.map(drop => drop.path);
  return {
    type: 'version_downgrade_fields_dropped',
    message:
      `${toolName}: removed ${paths.length} field(s) AdCP ${adcpMinorLine(step.lower) ?? step.lower} cannot express ` +
      `before sending to the seller: ${paths.join(', ')}.`,
    strippedFields: paths,
    fromVersion: step.upper,
    toVersion: step.lower,
  };
}

function identityDrift(toolName: string, drops: ProjectionDrop[], step: TranslationStep): VersionDrift {
  const paths = drops.map(drop => drop.path);
  return {
    type: 'account_identity_reduced',
    message:
      `${toolName}: account key reduced to AdCP ${adcpMinorLine(step.lower) ?? step.lower} by removing ${paths.join(', ')}. ` +
      'Buyer accounts that differ only in these fields share one seller account.',
    strippedFields: paths,
    fromVersion: step.upper,
    toVersion: step.lower,
  };
}

/**
 * Convert a request from `fromVersion` down to `toVersion`.
 *
 * Returns the original params reference when nothing changes. Identity
 * fields are always reported in `identityFields`; they are removed only under
 * `'reduce'`, which is also the only policy that emits
 * `account_identity_reduced` drift.
 */
export function convertRequestToRelease<T>(
  toolName: string,
  params: T,
  options: {
    fromVersion: string;
    toVersion: string;
    accountIdentity: AccountIdentityDowngrade;
    adapters: AdapterLookup;
    /** Whether the request changes seller state (`isMutatingTask`). */
    mutating: boolean;
  }
): RequestTranslation<T> {
  const drifts: VersionDrift[] = [];
  const identityFields: RequestTranslation['identityFields'] = [];
  const refusedFields: RequestTranslation['refusedFields'] = [];
  let current: unknown = params;
  for (const step of translationSteps(options.fromVersion, options.toVersion)) {
    const adapter = options.adapters(step.key, toolName);
    if (adapter?.adaptRequest) {
      const adapted = adapter.adaptRequest(current);
      current = adapted.params;
      if (adapted.drift) drifts.push({ ...adapted.drift, fromVersion: step.upper, toVersion: step.lower });
    }
    const projected = projectToolPayload(toolName, 'request', current, step.upper, step.lower);
    if (projected.dropped.length === 0) continue;
    const identity = projected.dropped.filter(isIdentityDrop);
    const other = projected.dropped.filter(drop => !isIdentityDrop(drop));
    const introducedIn = adcpMinorLine(step.upper) ?? step.upper;
    identityFields.push(...identity.map(drop => ({ path: drop.path, introducedIn })));
    if (options.mutating) {
      for (const drop of other) {
        if (!isDescriptiveDrop(toolName, drop)) refusedFields.push({ path: drop.path, introducedIn });
      }
    }
    current = projected.value;
    if (other.length > 0) drifts.push(droppedDrift(toolName, other, step));
    if (identity.length > 0 && options.accountIdentity === 'reduce') {
      drifts.push(identityDrift(toolName, identity, step));
    }
  }
  return { params: current as T, drifts, identityFields, refusedFields };
}

/**
 * Convert a response from the wire release `fromVersion` up to the client's
 * `toVersion` through each step's hand-written `adaptResponse`.
 */
export function convertResponseFromRelease<T>(
  toolName: string,
  data: T,
  options: { fromVersion: string; toVersion: string; adapters: AdapterLookup }
): ResponseTranslation<T> {
  const drifts: VersionDrift[] = [];
  let current: unknown = data;
  for (const step of [...translationSteps(options.toVersion, options.fromVersion)].reverse()) {
    const adapter = options.adapters(step.key, toolName);
    if (!adapter?.adaptResponse) continue;
    const adapted = adapter.adaptResponse(current);
    current = adapted.data;
    if (adapted.drift) drifts.push({ ...adapted.drift, fromVersion: step.lower, toVersion: step.upper });
  }
  return { data: current as T, drifts };
}

/**
 * Server side: convert an older buyer's request from the served release
 * `fromVersion` up to the server's release `toVersion` through each step's
 * `upgradeRequest`. Upward steps never remove fields.
 */
export function convertRequestFromRelease<T>(
  toolName: string,
  params: T,
  options: { fromVersion: string; toVersion: string; adapters: AdapterLookup }
): { params: T; drifts: VersionDrift[] } {
  const drifts: VersionDrift[] = [];
  let current: unknown = params;
  for (const step of [...translationSteps(options.toVersion, options.fromVersion)].reverse()) {
    const adapter = options.adapters(step.key, toolName);
    if (!adapter?.upgradeRequest) continue;
    const adapted = adapter.upgradeRequest(current);
    current = adapted.params;
    if (adapted.drift) drifts.push({ ...adapted.drift, fromVersion: step.lower, toVersion: step.upper });
  }
  return { params: current as T, drifts };
}

/**
 * Server side: convert a handler's response from the server's release
 * `fromVersion` down to the served release `toVersion`. Each step runs the
 * hand-written `downgradeResponse`, then removes and reports what the older
 * release's response schema cannot express.
 */
export function convertResponseToRelease<T>(
  toolName: string,
  data: T,
  options: { fromVersion: string; toVersion: string; adapters: AdapterLookup }
): { data: T; drifts: VersionDrift[] } {
  const drifts: VersionDrift[] = [];
  let current: unknown = data;
  for (const step of translationSteps(options.fromVersion, options.toVersion)) {
    const adapter = options.adapters(step.key, toolName);
    if (adapter?.downgradeResponse) {
      const adapted = adapter.downgradeResponse(current);
      current = adapted.data;
      if (adapted.drift) drifts.push({ ...adapted.drift, fromVersion: step.upper, toVersion: step.lower });
    }
    const projected = projectToolPayload(toolName, 'sync', current, step.upper, step.lower);
    if (projected.dropped.length === 0) continue;
    current = projected.value;
    drifts.push({
      ...droppedDrift(toolName, projected.dropped, step),
      message:
        `${toolName}: removed ${projected.dropped.length} response field(s) AdCP ` +
        `${adcpMinorLine(step.lower) ?? step.lower} cannot express: ${projected.dropped.map(d => d.path).join(', ')}.`,
    });
  }
  return { data: current as T, drifts };
}
