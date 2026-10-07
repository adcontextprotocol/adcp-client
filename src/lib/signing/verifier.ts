import { parseDictionary } from 'structured-headers';
import {
  buildSignatureBase,
  canonicalTargetUri,
  getHeaderValue,
  rejectNonAsciiHost,
  type RequestLike,
} from './canonicalize';
import {
  contentDigestMatches,
  contentDigestSha256Token,
  contentDigestUsesEncoding,
  requestSigningEncodingForVersion,
  type SfBinaryEncoding,
} from './content-digest';
import { RequestSignatureError } from './errors';
import { AgentResolverError } from './agent-resolver/errors';
import { parseStrictJson, StrictJsonError } from './agent-resolver/strict-json';
import { parseSignature, parseSignatureInput, type ParsedSignatureInput } from './parser';
import { jwkToPublicKey, verifySignature } from './crypto';
import { isUnresolvableOperation, type UnresolvableOperation } from './operation-resolution';
import type { JwksResolver } from './jwks';
import type { ReplayStore } from './replay';
import type { RevocationStore } from './revocation';
import { containsWebhookAuthentication, WEBHOOK_AUTH_TRAVERSAL_DEPTH } from './webhook-auth-detection';
import {
  ALLOWED_ALGS,
  CLOCK_SKEW_TOLERANCE_SECONDS,
  MANDATORY_COMPONENTS,
  MAX_SIGNATURE_WINDOW_SECONDS,
  REQUEST_SIGNING_TAG,
  type VerifierCapability,
  type VerifyResult,
  type VerifiedSigner,
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
   *
   * Pass {@link UNRESOLVABLE_OPERATION} when the request body does not resolve
   * to exactly one operation (see `resolveRequestOperation`). The verifier
   * then rejects with `request_body_malformed` before it looks at any
   * signature header or capability list, whether or not the request is signed.
   */
  operation?: string | UnresolvableOperation;
  /**
   * Trusted endpoint release pin; never inferred from request payload data.
   * A 3.2+ pin parses `Signature` and `Content-Digest` strictly as RFC 8941
   * padded standard Base64 and rejects Base64URL as
   * `request_signature_header_malformed`, regardless of
   * `capability.covers_content_digest`. When omitted, the verifier accepts
   * both the legacy 3.0/3.1 Base64URL representation and the 3.2+ RFC 8941
   * Base64 representation, so it cannot grade as a 3.2 verifier. Digest
   * coverage still follows `capability.covers_content_digest`.
   */
  adcpVersion?: string;
  agentUrlForKeyid?: (keyid: string) => string | undefined;
}

export async function verifyRequestSignature(
  request: RequestLike,
  options: VerifyRequestOptions
): Promise<VerifyResult> {
  const currentTime = options.now ?? (() => Math.floor(Date.now() / 1000));
  const now = currentTime();
  const pinnedBinaryEncoding =
    options.adcpVersion !== undefined ? requestSigningEncodingForVersion(options.adcpVersion) : undefined;
  const sigInputHeader = getHeaderValue(request.headers, 'Signature-Input');
  const sigHeader = getHeaderValue(request.headers, 'Signature');

  // Pre-check 0: the request must resolve to exactly one operation. This runs
  // before the header-pair checks and the `required_for` test, and whether or
  // not the request is signed — an unresolvable body is never "an operation
  // that is not in required_for".
  if (isUnresolvableOperation(options.operation)) throw unresolvableOperationError();
  const operation = options.operation;

  // Pre-check: both headers present or both absent.
  if (!sigInputHeader && !sigHeader) {
    // Precedence is intentionally fail-specific: AdCP tool required_for,
    // raw JSON-RPC protocol methods, then payload-driven webhook-auth
    // elevation. The specific signed-only contract should win before the
    // generic body scan runs.
    assertUnsignedRequestAllowed(request.body, operation, options.capability);
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
  const binaryEncodingCandidates = signatureEncodingCandidates(
    pinnedBinaryEncoding,
    options.capability?.covers_content_digest
  );
  let parsedSig: ReturnType<typeof parseSignature> | undefined;
  let parsedEncoding: SfBinaryEncoding | undefined;
  let parseError: unknown;
  for (const candidate of binaryEncodingCandidates) {
    try {
      parsedSig = parseSignature(sigHeader, parsedInput.label, candidate);
      parsedEncoding = candidate;
      break;
    } catch (error) {
      // When every candidate fails, report the pinned profile's diagnostic,
      // or the 3.2 one for an unpinned verifier.
      if (parseError === undefined || candidate === (pinnedBinaryEncoding ?? 'rfc8941-base64')) parseError = error;
    }
  }
  if (!parsedSig) throw parseError;
  const effectiveEncoding = pinnedBinaryEncoding ?? parsedEncoding!;
  const canonicalizationProfile = effectiveEncoding === 'rfc8941-base64' ? '3.2' : 'legacy';
  // A received signed authority must already use A-labels in every profile.
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
  // The 3.2 digest floor comes only from the trusted endpoint pin. Never
  // derive it from the request's attacker-controlled serialization.
  const effectiveCapability =
    pinnedBinaryEncoding === 'rfc8941-base64'
      ? { ...options.capability, covers_content_digest: 'required' as const }
      : options.capability;
  validateCoveredComponents(parsedInput.components, effectiveCapability, request);

  // Step 7: resolve keyid.
  let jwk;
  let resolvedAgentUrl: string | undefined;
  let authorizationValidUntil: number | undefined;
  let operatorRecord: VerifiedSigner['operatorRecord'];
  try {
    if (options.jwks.resolveWithMetadata) {
      const resolution = await options.jwks.resolveWithMetadata(parsedInput.params.keyid);
      if (resolution.legacyWebhookFallback)
        throw new AgentResolverError(
          'request_signature_brand_json_url_missing',
          'Legacy discovery is limited to webhook verification',
          {}
        );
      jwk = resolution.jwk;
      resolvedAgentUrl = resolution.agentUrl;
      operatorRecord = resolution.operatorRecord;
      authorizationValidUntil = resolution.operatorAuthorizationValidUntil;
    } else {
      jwk = await options.jwks.resolve(parsedInput.params.keyid);
    }
  } catch (err) {
    if (err instanceof AgentResolverError) {
      throw new RequestSignatureError(err.code, 7, err.message, err.detail, err.recovery);
    }
    throw err;
  }
  if (authorizationValidUntil !== undefined && currentTime() >= authorizationValidUntil) {
    throw new RequestSignatureError(
      'request_signature_brand_origin_mismatch',
      7,
      'Delegated operator authorization expired before verification'
    );
  }
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
  const replayScope = canonicalTargetUri(request.url, canonicalizationProfile);

  // Step 12 pre-checks (replay hit + rate-abuse cap) run before crypto so a
  // compromised-key cache cap or a replayed nonce short-circuits an expensive
  // Ed25519/ECDSA verify. Replay is checked first to preserve the store
  // contract's replay-over-cap result precedence. The committing insert
  // happens after step 11.
  if (await options.replayStore.has(jwk.kid, replayScope, parsedInput.params.nonce, now)) {
    throw new RequestSignatureError(
      'request_signature_replayed',
      12,
      `Replay of (keyid=${jwk.kid}, nonce=${parsedInput.params.nonce}) within signature window`
    );
  }
  if (await options.replayStore.isCapHit(jwk.kid, replayScope, now)) {
    // The nonce may have been committed between the first replay probe and
    // the cap probe. Re-check so same-nonce losers retain the store
    // contract's replay-over-cap classification under that race.
    if (await options.replayStore.has(jwk.kid, replayScope, parsedInput.params.nonce, now)) {
      throw new RequestSignatureError(
        'request_signature_replayed',
        12,
        `Replay of (keyid=${jwk.kid}, nonce=${parsedInput.params.nonce}) within signature window`
      );
    }
    throw new RequestSignatureError(
      'request_signature_rate_abuse',
      12,
      `Per-keyid replay cache cap exceeded for keyid=${jwk.kid}`
    );
  }

  // Step 10: cryptographic verify. Use the received Signature-Input value
  // verbatim as the @signature-params line so a peer emitting params in a
  // different legal order still produces a byte-identical base.
  const base = buildSignatureBase(
    parsedInput.components,
    request,
    parsedInput.params,
    parsedInput.signatureParamsValue,
    canonicalizationProfile
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
    const encodingMatches =
      !!digestHeader &&
      contentDigestEncodingCandidates(pinnedBinaryEncoding).some(candidate =>
        contentDigestUsesEncoding(digestHeader, candidate)
      );
    if (
      digestHeader &&
      !encodingMatches &&
      pinnedBinaryEncoding === 'rfc8941-base64' &&
      contentDigestSha256Token(digestHeader) !== undefined
    ) {
      // 3.2 request sf-binary is standard padded Base64 only; a Base64URL or
      // unpadded digest is a malformed header, not a digest mismatch.
      throw new RequestSignatureError(
        'request_signature_header_malformed',
        11,
        'Content-Digest sha-256 value must use padded standard Base64 for AdCP 3.2+'
      );
    }
    if (!digestHeader || !encodingMatches || !contentDigestMatches(digestHeader, request.body ?? '')) {
      throw new RequestSignatureError(
        'request_signature_digest_mismatch',
        11,
        'Content-Digest header does not match recomputed body hash'
      );
    }
  }

  // A valid digest authenticates bytes, not their interpretation. Reject
  // duplicate keys and other strict-JSON failures before committing the
  // nonce so different parsers cannot assign different meaning to one signed
  // body.
  if (request.body !== undefined && request.body.trim() !== '') {
    try {
      parseStrictJson(request.body);
    } catch (err) {
      if (err instanceof StrictJsonError) {
        throw new RequestSignatureError('request_body_malformed', 11, 'Signed request body is not strict JSON', {
          reason: err.code,
        });
      }
      throw err;
    }
  }

  if (authorizationValidUntil !== undefined && currentTime() >= authorizationValidUntil) {
    throw new RequestSignatureError(
      'request_signature_brand_origin_mismatch',
      7,
      'Delegated operator authorization expired during verification'
    );
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

  if (authorizationValidUntil !== undefined && currentTime() >= authorizationValidUntil) {
    throw new RequestSignatureError(
      'request_signature_brand_origin_mismatch',
      7,
      'Delegated operator authorization expired before acceptance'
    );
  }

  const agent_url = resolvedAgentUrl ?? options.agentUrlForKeyid?.(jwk.kid);
  return {
    status: 'verified',
    keyid: jwk.kid,
    agent_url,
    verified_at: now,
    ...(operatorRecord !== undefined && { operatorRecord }),
  };
}

function signatureEncodingCandidates(
  pinned: SfBinaryEncoding | undefined,
  digestPolicy: VerifierCapability['covers_content_digest'] | undefined
): readonly SfBinaryEncoding[] {
  // Unpinned: a token valid in both alphabets (no `+`, `/`, `-`, `_`, or `=`)
  // stays on the legacy profile, as it did before 3.2 existed.
  if (!pinned) return ['legacy-base64url', 'rfc8941-base64'];
  // A 3.2 endpoint parses `Signature` strictly as RFC 8941 sf-binary and MUST
  // NOT retry a Base64URL token through the legacy decoder, whatever its
  // internal digest policy (security.mdx, request-profile binary value
  // encoding). Only an explicitly pinned 3.0/3.1 endpoint in `either` mode
  // keeps accepting both serializations during a rolling upgrade.
  if (pinned === 'rfc8941-base64' || digestPolicy !== 'either') return [pinned];
  return ['legacy-base64url', 'rfc8941-base64'];
}

/** The `request_body_malformed` rejection for a body that resolves to no single operation. */
export function unresolvableOperationError(): RequestSignatureError {
  return new RequestSignatureError(
    'request_body_malformed',
    0,
    'Request body does not resolve to exactly one AdCP operation'
  );
}

/**
 * Throw `request_signature_required` when an UNSIGNED request must be signed:
 * its resolved operation is in `capability.required_for`, or its JSON-RPC
 * method is in `capability.protocol_methods_required_for`, or it carries
 * webhook authentication. Returns normally when none applies.
 *
 * "Unsigned" is the caller's contract: no `Signature` / `Signature-Input`
 * header. The checks do not consult any fallback credential; a caller that
 * lets a configured fallback authenticator satisfy `required_for` (the
 * presence-gated composer) runs the pieces separately.
 */
export function assertUnsignedRequestAllowed(
  body: string | undefined,
  operation: string | undefined,
  capability: Pick<VerifierCapability, 'required_for' | 'protocol_methods_required_for'>
): void {
  assertUnsignedOperationNotRequired(operation, capability);
  assertUnsignedProtocolMethodNotRequired(body, capability);
  assertUnsignedWebhookAuthenticationAbsent(body);
}

/** `required_for` half of {@link assertUnsignedRequestAllowed}. */
export function assertUnsignedOperationNotRequired(
  operation: string | undefined,
  capability: Pick<VerifierCapability, 'required_for'>
): void {
  if (operation && capability.required_for.includes(operation)) {
    throw new RequestSignatureError(
      'request_signature_required',
      0,
      `Operation "${operation}" requires a signed request`
    );
  }
}

/** `protocol_methods_required_for` half of {@link assertUnsignedRequestAllowed}. */
export function assertUnsignedProtocolMethodNotRequired(
  body: string | undefined,
  capability: Pick<VerifierCapability, 'protocol_methods_required_for'>
): void {
  const protocolMethodsRequiredFor = capability.protocol_methods_required_for ?? [];
  if (protocolMethodsRequiredFor.length === 0) return;
  if (exceedsUnsignedBodyInspectionCap(body)) {
    throw new RequestSignatureError(
      'request_signature_required',
      0,
      'Unsigned request body exceeds the protocol method inspection cap while protocol methods require signing'
    );
  }
  const requiredProtocolMethod = jsonRpcProtocolMethods(body).find(method =>
    protocolMethodsRequiredFor.includes(method)
  );
  if (requiredProtocolMethod) {
    throw new RequestSignatureError(
      'request_signature_required',
      0,
      `Protocol method "${requiredProtocolMethod}" requires a signed request`
    );
  }
}

/**
 * Payload-driven elevation: any request carrying webhook receiver credentials
 * (task, reporting, artifact, or revocation callbacks) MUST be RFC 9421
 * signed, regardless of whether the operation appears in `required_for`
 * (#webhook-security downgrade-resistance). A bearer-only channel would
 * otherwise let an attacker who captured a token register or update webhook
 * credentials and redirect callbacks to a hostile URL. Unlike `required_for`,
 * a valid fallback credential does not satisfy this.
 */
export function assertUnsignedWebhookAuthenticationAbsent(body: string | undefined): void {
  if (carriesWebhookAuthentication(body)) {
    throw new RequestSignatureError(
      'request_signature_required',
      0,
      'Requests carrying webhook authentication must be RFC 9421 signed'
    );
  }
}

function contentDigestEncodingCandidates(pinned: SfBinaryEncoding | undefined): readonly SfBinaryEncoding[] {
  // Legacy bundles contain both historical Base64URL digests and standards-
  // compliant RFC 8941 Base64 digests, so legacy and unpinned verifiers accept
  // both serializations. A 3.2 endpoint accepts only RFC 8941 Base64.
  if (pinned === 'rfc8941-base64') return [pinned];
  return ['rfc8941-base64', 'legacy-base64url'];
}

function jsonRpcProtocolMethods(body: string | undefined): string[] {
  if (!body) return [];
  if (exceedsUnsignedBodyInspectionCap(body)) return [];
  try {
    const parsed = JSON.parse(body) as unknown;
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return messages.flatMap(message =>
      message !== null && typeof message === 'object' && typeof (message as { method?: unknown }).method === 'string'
        ? [(message as { method: string }).method]
        : []
    );
  } catch {
    return [];
  }
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

/**
 * Upper bound on request body size we will JSON.parse and walk on the
 * unsigned branch. Real AdCP `update_media_buy` / `create_media_buy` payloads
 * are O(kilobytes); 1 MB is ~1000x that. Over this, require signing rather
 * than spend unbounded pre-crypto CPU on attacker-shaped input — a 1 MB
 * nested-array body would otherwise let an unauthenticated caller force
 * deep recursion on every request.
 */
const MAX_UNSIGNED_BODY_INSPECTION_BYTES = 1_048_576;
/**
 * Upper bound on recursion depth in `containsWebhookAuthentication`. Real
 * AdCP payloads reach depth ~5-8; 64 is generous without leaving room for
 * a pathological `{"a":{"a":{...}}}` to burn the stack.
 */
function exceedsUnsignedBodyInspectionCap(body: string | undefined): boolean {
  return typeof body === 'string' && body.length > MAX_UNSIGNED_BODY_INSPECTION_BYTES;
}

/**
 * Scan a JSON request body for a non-empty
 * webhook authentication object — anywhere in the tree, including inside
 * arrays of pending config updates. MCP uses `push_notification_config`;
 * A2A uses `pushNotificationConfig`. Runs only on the
 * unsigned branch; returning `true` triggers the webhook-security downgrade
 * rejection in {@link verifyRequestSignature}.
 *
 * The check is Content-Type independent: an attacker can't evade by
 * labeling a JSON body `text/plain`. A body that fails to parse as JSON
 * returns false so legitimate non-JSON transports (SSE posts, form uploads)
 * aren't blocked; signed-request enforcement for those remains
 * `required_for`-driven. A body over {@link MAX_UNSIGNED_BODY_INSPECTION_BYTES}
 * returns `true` — we can't prove absence of webhook auth within our DoS
 * budget, and oversized unsigned bodies are outside normal AdCP operation.
 */
function carriesWebhookAuthentication(body: string | undefined): boolean {
  if (!body) return false;
  if (exceedsUnsignedBodyInspectionCap(body)) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  return containsWebhookAuthentication(parsed, WEBHOOK_AUTH_TRAVERSAL_DEPTH);
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
