import { buildSignatureBase, getHeaderValue, type RequestLike } from './canonicalize';
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
  type VerifiedSigner,
  type VerifierCapability,
} from './types';

export interface VerifyRequestOptions {
  capability: VerifierCapability;
  jwks: JwksResolver;
  replayStore: ReplayStore;
  revocationStore: RevocationStore;
  now?: () => number;
  operation: string;
  agentUrlForKeyid?: (keyid: string) => string | undefined;
}

export async function verifyRequestSignature(
  request: RequestLike,
  options: VerifyRequestOptions
): Promise<VerifiedSigner> {
  const now = options.now ? options.now() : Math.floor(Date.now() / 1000);
  const sigInputHeader = getHeaderValue(request.headers, 'Signature-Input');
  const sigHeader = getHeaderValue(request.headers, 'Signature');

  // Pre-check: both headers present or both absent.
  if (!sigInputHeader && !sigHeader) {
    if (options.capability.required_for.includes(options.operation)) {
      throw new RequestSignatureError(
        'request_signature_required',
        0,
        `Operation "${options.operation}" requires a signed request`
      );
    }
    return { keyid: '', verified_at: now };
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

  // Step 9: revocation (runs BEFORE crypto to prevent amplification attacks).
  if (await options.revocationStore.isRevoked(jwk.kid)) {
    throw new RequestSignatureError('request_signature_key_revoked', 9, `JWK "${jwk.kid}" is revoked`);
  }

  // Step 12 pre-checks (rate-abuse cap + replay hit) run before crypto so a
  // compromised-key cache cap or a replayed nonce short-circuits an expensive
  // Ed25519/ECDSA verify. The committing insert happens after step 11.
  if (await options.replayStore.isCapHit(jwk.kid, now)) {
    throw new RequestSignatureError(
      'request_signature_rate_abuse',
      12,
      `Per-keyid replay cache cap exceeded for keyid=${jwk.kid}`
    );
  }
  if (await options.replayStore.has(jwk.kid, parsedInput.params.nonce, now)) {
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
  const insertResult = await options.replayStore.insert(jwk.kid, parsedInput.params.nonce, ttl, now);
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
  return { keyid: jwk.kid, agent_url, verified_at: now };
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
