/**
 * Step 7 of the brand_json_url discovery algorithm — `identity.key_origins`
 * consistency check (security.mdx §"Discovering an agent's signing keys via
 * `brand_json_url`" step 7). Two distinct rejections:
 *
 *   `request_signature_key_origin_mismatch` — the resolved `jwks_uri` host
 *     does not match the operator's declared `identity.key_origins.{purpose}`
 *     value. Skipped only for the specific (agent, purpose, role) tuple
 *     whose JWKS source was a publisher `adagents.json signing_keys` pin —
 *     operator-side use of the same purpose is still checked.
 *
 *   `request_signature_key_origin_missing` — the agent's capabilities
 *     declare a signing posture for a purpose (e.g. `request_signing.supported_for`
 *     non-empty, `webhook_signing.supported === true`) but the corresponding
 *     `identity.key_origins.{purpose}` entry is absent.
 *
 * Both checks are pure: the caller supplies the inputs (which purposes are
 * declared, the declared origins, the resolved jwksUri, whether the resolution
 * came from a publisher pin), the function returns a typed result. No I/O.
 */

import { canonicalizeOrigin } from './canonicalize';
import type { IdentityKeyOrigins, IdentityKeyOriginPurpose, IdentityPosture } from './capabilities-types';

export type ConsistencyErrorCode = 'key_origin_mismatch' | 'key_origin_missing';

export interface KeyOriginMismatch {
  ok: false;
  code: 'key_origin_mismatch';
  purpose: IdentityKeyOriginPurpose;
  expected_origin: string;
  actual_origin: string;
}

export interface KeyOriginMissing {
  ok: false;
  code: 'key_origin_missing';
  purpose: IdentityKeyOriginPurpose;
  posture: 'request_signing' | 'webhook_signing' | 'governance_signing' | 'tmp_signing';
}

export type ConsistencyResult = { ok: true } | KeyOriginMismatch | KeyOriginMissing;

/**
 * Inputs for the per-purpose origin check. The caller is responsible for
 * deciding whether `publisherPinned` is true — the carve-out applies only
 * to (agent, webhook-signing, sell-side) tuples whose JWKS came from an
 * `adagents.json signing_keys` pin. For request-signing, governance-signing,
 * TMP-signing, and buyer-side webhook receivers, `publisherPinned` MUST
 * always be false.
 */
export interface OriginCheckInput {
  purpose: IdentityKeyOriginPurpose;
  declaredOrigin: string | undefined;
  resolvedJwksUri: string;
  publisherPinned: boolean;
}

/**
 * Check origin consistency for a single (purpose, jwksUri) pair against the
 * declared `identity.key_origins.{purpose}` value. Returns `{ ok: true }`
 * when the check passes or is skipped (publisher pin); a typed mismatch
 * result on failure. `key_origin_missing` is NOT raised here — that is a
 * separate check (`checkRequiredOrigins`) because it depends on which
 * purposes the agent has declared signing for.
 */
export function checkOriginConsistency(input: OriginCheckInput): ConsistencyResult {
  if (input.publisherPinned) return { ok: true };
  if (!input.declaredOrigin) return { ok: true };
  let expected: string;
  let actual: string;
  try {
    expected = canonicalizeOrigin(input.declaredOrigin);
    actual = canonicalizeOrigin(input.resolvedJwksUri);
  } catch {
    return {
      ok: false,
      code: 'key_origin_mismatch',
      purpose: input.purpose,
      expected_origin: input.declaredOrigin,
      actual_origin: input.resolvedJwksUri,
    };
  }
  if (expected !== actual) {
    return {
      ok: false,
      code: 'key_origin_mismatch',
      purpose: input.purpose,
      expected_origin: expected,
      actual_origin: actual,
    };
  }
  return { ok: true };
}

/**
 * Determine which signing purposes the capabilities response declares.
 * Any of the following signal a declared purpose, per security.mdx
 * §"Discovering an agent's signing keys via `brand_json_url`" step 2:
 *
 *   - `request_signing.supported_for` non-empty            → `request_signing`
 *   - `request_signing.required_for` non-empty             → `request_signing`
 *   - `webhook_signing.supported === true`                 → `webhook_signing`
 *   - any field present under `identity.key_origins`       → that purpose
 *
 * Governance-signing and TMP-signing declarations are agent-protocol-specific
 * and not reliably detectable from a generic capabilities walk; callers may
 * pass `extraDeclaredPurposes` for purposes they have detected externally.
 */
export function declaredSigningPurposes(
  capabilities: unknown,
  extraDeclaredPurposes: readonly IdentityKeyOriginPurpose[] = []
): Set<IdentityKeyOriginPurpose> {
  const out = new Set<IdentityKeyOriginPurpose>(extraDeclaredPurposes);
  if (!capabilities || typeof capabilities !== 'object') return out;
  const caps = capabilities as Record<string, unknown>;
  const requestSigning = caps.request_signing as { supported_for?: unknown; required_for?: unknown } | undefined;
  if (Array.isArray(requestSigning?.supported_for) && requestSigning.supported_for.length > 0) {
    out.add('request_signing');
  }
  if (Array.isArray(requestSigning?.required_for) && requestSigning.required_for.length > 0) {
    out.add('request_signing');
  }
  const webhookSigning = caps.webhook_signing as { supported?: unknown } | undefined;
  if (webhookSigning?.supported === true) {
    out.add('webhook_signing');
  }
  const identity = caps.identity as IdentityPosture | undefined;
  if (identity?.key_origins) {
    for (const purpose of Object.keys(identity.key_origins) as IdentityKeyOriginPurpose[]) {
      if (identity.key_origins[purpose] !== undefined) out.add(purpose);
    }
  }
  return out;
}

/**
 * For every purpose the agent has declared signing for, confirm an
 * `identity.key_origins.{purpose}` entry is present. Returns the set of
 * missing purposes; the caller maps each onto `request_signature_key_origin_missing`
 * with `posture` set to the corresponding signing field name.
 */
export function checkRequiredOrigins(
  declaredPurposes: ReadonlySet<IdentityKeyOriginPurpose>,
  keyOrigins: IdentityKeyOrigins | undefined
): KeyOriginMissing[] {
  const missing: KeyOriginMissing[] = [];
  for (const purpose of declaredPurposes) {
    const value = keyOrigins?.[purpose];
    if (typeof value !== 'string' || value.length === 0) {
      missing.push({ ok: false, code: 'key_origin_missing', purpose, posture: purpose });
    }
  }
  return missing;
}
