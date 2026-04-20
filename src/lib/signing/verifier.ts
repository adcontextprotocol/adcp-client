import { parseDictionary } from 'structured-headers';
import { buildSignatureBase, canonicalTargetUri, getHeaderValue, rejectNonAsciiHost, type RequestLike } from './canonicalize';
import { contentDigestMatches } from './content-digest';
import { RequestSignatureError } from './errors';
import { parseSignature, parseSignatureInput, type ParsedSignatureInput } from './parser';
import { jwkToPublicKey, verifySignature } from './crypto';
import type { JwksResolver } from './jwks';
import type { ReplayStore } from './replay';
import type { RevocationStore } from './revocation';
import {
  ALLOWED_ALGS,
  CLOCK_SKEW_TOLERANCE_SECONDS,
  MANDATORY_COMPONENTS,
  MAX_SIGNATURE_WINDOW_SECONDS,
  REQUEST_SIGNING_TAG,
  type VerifierCapability,
  type VerifyResult,
} from './types';

export interface VerifyRequestOptions {
  capability: VerifierCapability;
  jwks: JwksResolver;
  replayStore: ReplayStore;
  revocationStore: RevocationStore;
  now?: () => number;
  /**
   * The AdCP operation being requested, used to consult
   * `capability.required_for` when an unsigned request arrives. When omitted,
   * the verifier treats the operation as "not in any required_for list" and
   * returns an unsigned result rather than rejecting — callers in
   * always-verify mode (where every request is signed) can leave this blank.
   */
  operation?: string;
  agentUrlForKeyid?: (keyid: string) => string | undefined;
}

export async function verifyRequestSignature(
  request: RequestLike,
  options: VerifyRequestOptions
): Promise<VerifyResult> {
  const now = options.now ? options.now() : Math.floor(Date.now() / 1000);
  const sigInputHeader = getHeaderValue(request.headers, 'Signature-Input');
  const sigHeader = getHeaderValue(request.headers, 'Signature');

  // Pre-check: both headers present or both absent.
  if (!sigInputHeader && !sigHeader) {
    const operation = options.operation;
    if (operation && options.capability.required_for.includes(operation)) {
      throw new RequestSignatureError(
        'request_signature_required',
        0,
        `Operation "${operation}" requires a signed request`
      );
    }
    return { status: 'unsigned', verified_at: now };
  }
  if (!sigInputHeader || !sigHeader) {
    throw new RequestSignatureError(
      'request_signature_header_malformed',
      1,
      'Signature and Signature-Input headers must be present as a pair'
    );
  }

  // Step 1: parse.
  const parsedInput = parseSignatureInput(sigInputHeader);
  const parsedSig = parseSignature(sigHeader, parsedInput.label);
  rejectNonAsciiHost(request.url);
  validateSingleValuedCoveredHeaders(parsedInput.components, request);

  // Step 2: required params present.
  requireParams(parsedInput);

  // Step 3: tag match.
  if (parsedInput.params.tag !== REQUEST_SIGNING_TAG) {
    throw new RequestSignatureError(
      'request_signature_tag_invalid',
      3,
      `Signature tag must be "${REQUEST_SIGNING_TAG}"; got "${parsedInput.params.tag}"`
    );
  }

  // Step 4: alg allowlist.
  if (!ALLOWED_ALGS.has(parsedInput.params.alg)) {
    throw new RequestSignatureError(
      'request_signature_alg_not_allowed',
      4,
      `Signature alg "${parsedInput.params.alg}" is not in the AdCP allowlist`
    );
  }

  // Step 5: window valid.
  validateWindow(parsedInput.params.created, parsedInput.params.expires, now);

  // Step 6: covered components.
  validateCoveredComponents(parsedInput.components, options.capability, request);

  // Step 7: resolve keyid.
  const jwk = await options.jwks.resolve(parsedInput.params.keyid);
  if (!jwk) {
    throw new RequestSignatureError(
      'request_signature_key_unknown',
      7,
      `No JWK found for keyid "${parsedInput.params.keyid}"`
    );
  }
  if (jwk.kid !== parsedInput.params.keyid) {
    throw new RequestSignatureError(
      'request_signature_key_unknown',
      7,
      `JWKS resolver returned a JWK whose kid "${jwk.kid}" does not match requested keyid "${parsedInput.params.keyid}"`
    );
  }

  // Step 8: key purpose.
  if (jwk.adcp_use !== 'request-signing' || !jwk.key_ops?.includes('verify')) {
    throw new RequestSignatureError(
      'request_signature_key_purpose_invalid',
      8,
      `JWK "${jwk.kid}" is not scoped for request-signing verification`
    );
  }
  validateJwkParameterConsistency(jwk, parsedInput.params.alg);

  // Step 9: revocation (runs BEFORE crypto to prevent amplification attacks).
  if (await options.revocationStore.isRevoked(jwk.kid)) {
    throw new RequestSignatureError('request_signature_key_revoked', 9, `JWK "${jwk.kid}" is revoked`);
  }

  // Replay cache is scoped by `(keyid, @target-uri)` per adcp#2460 — a
  // signature captured on one endpoint (e.g. /create_media_buy) MUST NOT
  // count against the replay budget for a different endpoint under the
  // same keyid. Canonicalize once and reuse for both pre-check and commit.
  const replayScope = canonicalTargetUri(request.url);

  // Step 12 pre-checks (rate-abuse cap + replay hit) run before crypto so a
  // compromised-key cache cap or a replayed nonce short-circuits an expensive
  // Ed25519/ECDSA verify. The committing insert happens after step 11.
  if (await options.replayStore.isCapHit(jwk.kid, replayScope, now)) {
    throw new RequestSignatureError(
      'request_signature_rate_abuse',
      12,
      `Per-keyid replay cache cap exceeded for keyid=${jwk.kid}`
    );
  }
  if (await options.replayStore.has(jwk.kid, replayScope, parsedInput.params.nonce, now)) {
    throw new RequestSignatureError(
      'request_signature_replayed',
      12,
      `Replay of (keyid=${jwk.kid}, nonce=${parsedInput.params.nonce}) within signature window`
    );
  }

  // Step 10: cryptographic verify. Use the received Signature-Input value
  // verbatim as the @signature-params line so a peer emitting params in a
  // different legal order still produces a byte-identical base.
  const base = buildSignatureBase(
    parsedInput.components,
    request,
    parsedInput.params,
    parsedInput.signatureParamsValue
  );
  const publicKey = jwkToPublicKey(jwk);
  const valid = verifySignature(parsedInput.params.alg, publicKey, Buffer.from(base, 'utf8'), parsedSig.bytes);
  if (!valid) {
    throw new RequestSignatureError(
      'request_signature_invalid',
      10,
      'Cryptographic verification of signature base failed'
    );
  }

  // Step 11: content-digest match (only if covered).
  if (parsedInput.components.includes('content-digest')) {
    const digestHeader = getHeaderValue(request.headers, 'Content-Digest');
    if (!digestHeader || !contentDigestMatches(digestHeader, request.body ?? '')) {
      throw new RequestSignatureError(
        'request_signature_digest_mismatch',
        11,
        'Content-Digest header does not match recomputed body hash'
      );
    }
  }

  // Step 12: commit the (keyid, nonce) into the replay cache now that all
  // prior checks have passed. Floor the TTL at one max-window + skew so a
  // signer minting tiny validity windows can't replay outside the configured
  // replay horizon, and so cross-replica eventual consistency has headroom.
  const remaining = parsedInput.params.expires - now + CLOCK_SKEW_TOLERANCE_SECONDS;
  const ttl = Math.max(remaining, MAX_SIGNATURE_WINDOW_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS);
  const insertResult = await options.replayStore.insert(jwk.kid, replayScope, parsedInput.params.nonce, ttl, now);
  if (insertResult === 'replayed') {
    throw new RequestSignatureError(
      'request_signature_replayed',
      12,
      `Replay of (keyid=${jwk.kid}, nonce=${parsedInput.params.nonce}) within signature window`
    );
  }
  if (insertResult === 'rate_abuse') {
    throw new RequestSignatureError(
      'request_signature_rate_abuse',
      12,
      `Per-keyid replay cache cap exceeded for keyid=${jwk.kid}`
    );
  }

  const agent_url = options.agentUrlForKeyid?.(jwk.kid);
  return { status: 'verified', keyid: jwk.kid, agent_url, verified_at: now };
}

function requireParams(parsed: ParsedSignatureInput): void {
  const required: Array<keyof ParsedSignatureInput['params']> = ['created', 'expires', 'nonce', 'keyid', 'alg', 'tag'];
  const missing = required.filter(k => parsed.params[k] === undefined);
  if (missing.length) {
    throw new RequestSignatureError(
      'request_signature_params_incomplete',
      2,
      `Signature-Input missing required parameter(s): ${missing.join(', ')}`
    );
  }
}

function validateWindow(created: number, expires: number, now: number): void {
  if (expires <= created) {
    throw new RequestSignatureError(
      'request_signature_window_invalid',
      5,
      'Signature expires must be strictly greater than created'
    );
  }
  if (expires - created > MAX_SIGNATURE_WINDOW_SECONDS) {
    throw new RequestSignatureError(
      'request_signature_window_invalid',
      5,
      `Signature window exceeds ${MAX_SIGNATURE_WINDOW_SECONDS}s maximum`
    );
  }
  if (now > expires + CLOCK_SKEW_TOLERANCE_SECONDS) {
    throw new RequestSignatureError('request_signature_window_invalid', 5, 'Signature is expired');
  }
  if (now < created - CLOCK_SKEW_TOLERANCE_SECONDS) {
    throw new RequestSignatureError(
      'request_signature_window_invalid',
      5,
      'Signature created is in the future beyond skew tolerance'
    );
  }
}

/**
 * Reject JWKs whose alg/kty/crv are mutually inconsistent OR don't match
 * the sig-params alg. Three checks in one place:
 *
 * 1. JWK MUST declare `alg`. A missing alg lets a signer substitute one
 *    algorithm family for another (e.g. EdDSA sig-params against a P-256
 *    JWK) and defer failure to step 10's crypto verify — the wrong step
 *    and the wrong error code.
 * 2. JWK `alg` MUST match the sig-params `alg` after AdCP→JOSE mapping
 *    (`ed25519`↔`EdDSA`, `ecdsa-p256-sha256`↔`ES256`). Prevents sig-params
 *    alg-downgrade against a JWK that was published for a stronger alg.
 * 3. JWK kty/crv MUST be consistent with the declared alg per RFC 8037
 *    (EdDSA→OKP/Ed25519|Ed448) and RFC 7518 (ES256→EC/P-256).
 */
function validateJwkParameterConsistency(
  jwk: { kid: string; kty?: string; crv?: string; alg?: string },
  sigParamsAlg: string
): void {
  if (!jwk.alg) {
    throw new RequestSignatureError(
      'request_signature_key_purpose_invalid',
      8,
      `JWK "${jwk.kid}" does not declare an alg; cannot bind to sig-params alg="${sigParamsAlg}"`
    );
  }
  const expectedJoseAlg = SIG_PARAMS_ALG_TO_JOSE[sigParamsAlg];
  if (expectedJoseAlg && jwk.alg !== expectedJoseAlg) {
    throw new RequestSignatureError(
      'request_signature_key_purpose_invalid',
      8,
      `JWK "${jwk.kid}" declares alg=${jwk.alg} but the request is signed with alg="${sigParamsAlg}" (JOSE ${expectedJoseAlg})`
    );
  }
  if (jwk.alg === 'EdDSA') {
    if (jwk.kty !== 'OKP' || (jwk.crv !== 'Ed25519' && jwk.crv !== 'Ed448')) {
      throw new RequestSignatureError(
        'request_signature_key_purpose_invalid',
        8,
        `JWK "${jwk.kid}" declares alg=EdDSA but kty/crv (${jwk.kty}/${jwk.crv}) is not a valid Edwards-curve pair`
      );
    }
    return;
  }
  if (jwk.alg === 'ES256') {
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') {
      throw new RequestSignatureError(
        'request_signature_key_purpose_invalid',
        8,
        `JWK "${jwk.kid}" declares alg=ES256 but kty/crv (${jwk.kty}/${jwk.crv}) is not EC/P-256`
      );
    }
  }
}

const SIG_PARAMS_ALG_TO_JOSE: Record<string, string> = {
  ed25519: 'EdDSA',
  'ecdsa-p256-sha256': 'ES256',
};

/**
 * Covered components referencing single-valued HTTP header fields
 * (Content-Type per RFC 9110, Content-Digest per RFC 9530) MUST NOT arrive
 * as a comma-joined multi-value. A proxy or buggy client emitting the field
 * twice produces a concatenated value whose meaning relative to the
 * signature base is undefined — reject at parse rather than pick one.
 */
function validateSingleValuedCoveredHeaders(components: string[], request: RequestLike): void {
  if (components.includes('content-type')) {
    const value = getHeaderValue(request.headers, 'Content-Type');
    if (value !== undefined && containsTopLevelComma(value)) {
      throw new RequestSignatureError(
        'request_signature_header_malformed',
        1,
        'Content-Type header covered by signature must be single-valued; multiple field values are ambiguous'
      );
    }
  }
  if (components.includes('content-digest')) {
    const value = getHeaderValue(request.headers, 'Content-Digest');
    if (value !== undefined) {
      try {
        const dict = parseDictionary(value);
        const seen = new Map<string, number>();
        for (const key of dict.keys()) {
          seen.set(key, (seen.get(key) ?? 0) + 1);
        }
        for (const [key, count] of seen) {
          if (count > 1) {
            throw new RequestSignatureError(
              'request_signature_header_malformed',
              1,
              `Content-Digest declares the "${key}" algorithm more than once; duplicate members are ambiguous`
            );
          }
        }
      } catch (e) {
        if (e instanceof RequestSignatureError) throw e;
      }
      // The structured-headers library deduplicates dictionary keys silently.
      // Detect the multi-value case at the raw-string level too so the
      // specific "two sha-256 members" shape is caught.
      if (containsDuplicateDictKey(value)) {
        throw new RequestSignatureError(
          'request_signature_header_malformed',
          1,
          'Content-Digest declares the same algorithm more than once; duplicate members are ambiguous'
        );
      }
    }
  }
}

function containsTopLevelComma(value: string): boolean {
  let inQuoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === '\\' && i + 1 < value.length && inQuoted) {
      i++;
      continue;
    }
    if (ch === '"') {
      inQuoted = !inQuoted;
      continue;
    }
    if (ch === ',' && !inQuoted) return true;
  }
  return false;
}

function containsDuplicateDictKey(value: string): boolean {
  const keys: string[] = [];
  let i = 0;
  const len = value.length;
  let atEntryStart = true;
  while (i < len) {
    if (atEntryStart) {
      while (i < len && (value[i] === ' ' || value[i] === '\t')) i++;
      const start = i;
      while (i < len && /[A-Za-z0-9_*-]/.test(value[i]!)) i++;
      if (i > start) keys.push(value.slice(start, i).toLowerCase());
      atEntryStart = false;
      continue;
    }
    const ch = value[i]!;
    if (ch === '"') {
      i++;
      while (i < len) {
        if (value[i] === '\\' && i + 1 < len) {
          i += 2;
          continue;
        }
        if (value[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === ':') {
      i++;
      while (i < len && value[i] !== ':') i++;
      if (i < len) i++;
      continue;
    }
    if (ch === ',') {
      atEntryStart = true;
      i++;
      continue;
    }
    i++;
  }
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function validateCoveredComponents(components: string[], capability: VerifierCapability, request: RequestLike): void {
  for (const mandatory of MANDATORY_COMPONENTS) {
    if (!components.includes(mandatory)) {
      throw new RequestSignatureError(
        'request_signature_components_incomplete',
        6,
        `Covered components must include "${mandatory}"`
      );
    }
  }
  const hasBody = (request.body ?? '').length > 0;
  if (hasBody && !components.includes('content-type')) {
    throw new RequestSignatureError(
      'request_signature_components_incomplete',
      6,
      'Covered components must include "content-type" when a request body is present'
    );
  }
  const includesDigest = components.includes('content-digest');
  if (capability.covers_content_digest === 'required' && !includesDigest) {
    throw new RequestSignatureError(
      'request_signature_components_incomplete',
      6,
      'Verifier requires content-digest coverage'
    );
  }
  if (capability.covers_content_digest === 'forbidden' && includesDigest) {
    throw new RequestSignatureError(
      'request_signature_components_unexpected',
      6,
      'Verifier forbids content-digest coverage'
    );
  }
}
