/**
 * RFC 9421 response-signing verifier (§2.2.9).
 *
 * Companion to `verifier.ts` (request signatures) and `webhook-verifier.ts`
 * (webhook callbacks). This verifier runs on the buyer / receiver side of
 * a signed response: a client receives a response from a seller agent and
 * hands it here, with the originating request URL the client sent, for
 * signature validation before parsing the body.
 *
 * Distinct from request / webhook signing:
 *   - Tag: `adcp/response-signing/v1`.
 *   - Key purpose: `adcp_use: "response-signing"`.
 *   - Default covered components: `@status`, `@authority`, `@target-uri`,
 *     plus `content-type` + `content-digest` when the body is non-empty.
 *   - The originating request URL is carried explicitly on `ResponseLike.request`
 *     because RFC 9421 §2.2 binds response signatures to their request
 *     context via `@authority` and `@target-uri`. The client supplies the URL
 *     it actually sent — a malformed reconstruction (e.g. `req.protocol`
 *     lying behind a proxy) will trip step 6a or fail the crypto check.
 *
 * Checklist steps below mirror the 13-step shape in `webhook-verifier.ts`
 * so failures point at the same step numbers the request and webhook
 * verifiers use. Numbers are 1-based.
 */

import { buildResponseSignatureBase, canonicalTargetUri, getHeaderValue, type ResponseLike } from './canonicalize';
import { contentDigestMatches } from './content-digest';
import { RequestSignatureError, ResponseSignatureError } from './errors';
import { parseSignature, parseSignatureInput, type ParsedSignatureInput } from './parser';
import { jwkToPublicKey, verifySignature } from './crypto';
import type { JwksResolver } from './jwks';
import { InMemoryReplayStore, type ReplayStore } from './replay';
import { InMemoryRevocationStore, type RevocationStore } from './revocation';
import {
  ALLOWED_ALGS,
  CLOCK_SKEW_TOLERANCE_SECONDS,
  MAX_SIGNATURE_WINDOW_SECONDS,
  RESPONSE_MANDATORY_COMPONENTS,
  RESPONSE_SIGNING_TAG,
} from './types';

export interface VerifyResponseOptions {
  jwks: JwksResolver;
  replayStore: ReplayStore;
  revocationStore: RevocationStore;
  /** Now in seconds since epoch. Defaults to `Date.now() / 1000`. */
  now?: () => number;
  /**
   * Optional tag override — spec currently defines exactly
   * `adcp/response-signing/v1`; the override lets test vectors pin a
   * version.
   */
  requiredTag?: string;
  /** Optional reverse-lookup (kid → publisher URL) for result attribution. */
  agentUrlForKeyid?: (keyid: string) => string | undefined;
}

export interface VerifyResponseResult {
  status: 'verified';
  keyid: string;
  agent_url?: string;
  verified_at: number;
}

/**
 * Verify an inbound response's RFC 9421 signature.
 *
 * Ordering invariant matches the webhook verifier: cheap invariant checks
 * (tag, alg, window, components) run before JWKS resolution; revocation and
 * rate-abuse run before cryptographic verify so an attacker can't amplify
 * Ed25519/ECDSA work. Replay insert commits only after every earlier check
 * passes — any signature failing crypto verify never consumes a cap entry.
 *
 * The replay scope is `(keyid, @target-uri-of-originating-request)`. Two
 * responses to two different request URLs under the same keyid use
 * independent replay budgets — same shape as webhook verification.
 *
 * Throws {@link ResponseSignatureError} on the first failed step.
 */
export async function verifyResponseSignature(
  response: ResponseLike,
  options: VerifyResponseOptions
): Promise<VerifyResponseResult> {
  const now = options.now ? options.now() : Math.floor(Date.now() / 1000);
  const requiredTag = options.requiredTag ?? RESPONSE_SIGNING_TAG;

  // Step 1: both signature headers present AND parseable. Bound-pair rule.
  const sigInputHeader = getHeaderValue(response.headers, 'Signature-Input');
  const sigHeader = getHeaderValue(response.headers, 'Signature');
  if (!sigInputHeader || !sigHeader) {
    throw new ResponseSignatureError(
      'response_signature_header_malformed',
      1,
      'Response is missing Signature or Signature-Input headers.'
    );
  }
  let parsedInput: ParsedSignatureInput;
  let parsedSig: ReturnType<typeof parseSignature>;
  try {
    parsedInput = parseSignatureInput(sigInputHeader);
    parsedSig = parseSignature(sigHeader, parsedInput.label);
  } catch (err) {
    throw new ResponseSignatureError(
      'response_signature_header_malformed',
      1,
      err instanceof Error ? err.message : String(err)
    );
  }

  // Step 2: required params present.
  requireParams(parsedInput);

  // Step 3: tag match.
  if (parsedInput.params.tag !== requiredTag) {
    throw new ResponseSignatureError(
      'response_signature_tag_invalid',
      3,
      `Signature tag must be "${requiredTag}"; got "${parsedInput.params.tag}".`
    );
  }

  // Step 4: alg allowlist.
  if (!ALLOWED_ALGS.has(parsedInput.params.alg)) {
    throw new ResponseSignatureError(
      'response_signature_alg_not_allowed',
      4,
      `Signature alg "${parsedInput.params.alg}" is not in the AdCP allowlist.`
    );
  }

  // Step 5: window valid.
  validateWindow(parsedInput.params.created, parsedInput.params.expires, now);

  // Step 6: covered components must include the response-signing mandatory set.
  validateCoveredComponents(parsedInput.components, response.body);

  // Step 6a: `@target-uri` syntactic validation against the originating-
  // request URL the caller passed in. Same rationale as the webhook
  // verifier — flag dangerous URI shapes (non-https, userinfo, fragment)
  // before cryptographic work. Distinct from `header_malformed`, which
  // flags the Signature / Signature-Input headers.
  validateTargetUri(response.request.url);

  // Step 7: resolve keyid.
  const jwk = await options.jwks.resolve(parsedInput.params.keyid);
  if (!jwk) {
    throw new ResponseSignatureError(
      'response_signature_key_unknown',
      7,
      `No JWK found for keyid "${parsedInput.params.keyid}".`
    );
  }
  if (jwk.kid !== parsedInput.params.keyid) {
    throw new ResponseSignatureError(
      'response_signature_key_unknown',
      7,
      `JWKS resolver returned a JWK whose kid "${jwk.kid}" does not match requested keyid "${parsedInput.params.keyid}".`
    );
  }

  // Step 8: key purpose — MUST be scoped for response signing.
  //
  // Same split as webhook: "no purpose declared" vs "declared but wrong".
  // The former needs the publisher to add a purpose; the latter needs a
  // new keypair (purpose binding is the whole point of `adcp_use`).
  if (jwk.adcp_use === undefined || !jwk.key_ops?.includes('verify')) {
    throw new ResponseSignatureError(
      'response_signature_key_purpose_invalid',
      8,
      `JWK "${jwk.kid}" is not scoped for response-signing verification.`
    );
  }
  if (jwk.adcp_use !== 'response-signing') {
    throw new ResponseSignatureError(
      'response_mode_mismatch',
      8,
      `JWK "${jwk.kid}" declares adcp_use="${jwk.adcp_use}" but this endpoint requires "response-signing".`
    );
  }

  // Step 9: revocation. The shared revocation store throws
  // `request_signature_revocation_stale` when its cached snapshot is past
  // grace — re-map to the response taxonomy so callers see consistent codes.
  try {
    if (await options.revocationStore.isRevoked(jwk.kid)) {
      throw new ResponseSignatureError('response_signature_key_revoked', 9, `JWK "${jwk.kid}" is revoked.`);
    }
  } catch (err) {
    if (err instanceof RequestSignatureError && err.code === 'request_signature_revocation_stale') {
      throw new ResponseSignatureError('response_signature_revocation_stale', 9, err.message);
    }
    throw err;
  }

  // Replay scope is `(keyid, @target-uri-of-originating-request)` — same
  // rationale as webhook signing. A response to /adcp/get_products MUST NOT
  // count against the replay budget for a response to /adcp/create_media_buy
  // under the same keyid.
  const replayScope = canonicalTargetUri(response.request.url);

  // Step 9a: per-keyid rate abuse. Distinct code from step 12 replay — cap
  // exhaustion is a compromised-key / misconfig signal, not "same nonce
  // twice."
  if (await options.replayStore.isCapHit(jwk.kid, replayScope, now)) {
    throw new ResponseSignatureError(
      'response_signature_rate_abuse',
      9,
      `Per-keyid replay cache cap exceeded for keyid=${jwk.kid}.`
    );
  }

  // Pre-check replay before crypto so a replayed nonce short-circuits an
  // expensive Ed25519 / ECDSA verify.
  if (await options.replayStore.has(jwk.kid, replayScope, parsedInput.params.nonce, now)) {
    throw new ResponseSignatureError(
      'response_signature_replayed',
      12,
      `Replay of (keyid=${jwk.kid}, nonce=${parsedInput.params.nonce}) within signature window.`
    );
  }

  // Step 10: cryptographic verify. Use the verbatim signatureParamsValue
  // from the parsed input so byte-identity with what the signer sent is
  // preserved regardless of param-order differences across SDKs.
  const base = buildResponseSignatureBase(
    parsedInput.components,
    response,
    parsedInput.params,
    parsedInput.signatureParamsValue
  );
  const publicKey = jwkToPublicKey(jwk);
  const valid = verifySignature(parsedInput.params.alg, publicKey, Buffer.from(base, 'utf8'), parsedSig.bytes);
  if (!valid) {
    throw new ResponseSignatureError(
      'response_signature_invalid',
      10,
      'Cryptographic verification of response signature base failed.'
    );
  }

  // Step 11: content-digest match (only when the signature covered it).
  if (parsedInput.components.includes('content-digest')) {
    const digestHeader = getHeaderValue(response.headers, 'Content-Digest');
    if (!digestHeader || !contentDigestMatches(digestHeader, response.body ?? '')) {
      throw new ResponseSignatureError(
        'response_signature_digest_mismatch',
        11,
        'Content-Digest header does not match recomputed body hash.'
      );
    }
  }

  // Step 13: commit nonce. Insert AFTER every prior check passes — external
  // traffic can't grow the cap because any signature failing at step 10
  // never reaches this point.
  const remaining = parsedInput.params.expires - now + CLOCK_SKEW_TOLERANCE_SECONDS;
  const ttl = Math.max(remaining, MAX_SIGNATURE_WINDOW_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS);
  const insertResult = await options.replayStore.insert(jwk.kid, replayScope, parsedInput.params.nonce, ttl, now);
  if (insertResult === 'replayed') {
    throw new ResponseSignatureError(
      'response_signature_replayed',
      13,
      `Replay of (keyid=${jwk.kid}, nonce=${parsedInput.params.nonce}) within signature window.`
    );
  }
  if (insertResult === 'rate_abuse') {
    throw new ResponseSignatureError(
      'response_signature_rate_abuse',
      13,
      `Per-keyid replay cache cap exceeded on commit for keyid=${jwk.kid}.`
    );
  }

  const agent_url = options.agentUrlForKeyid?.(jwk.kid);
  return { status: 'verified', keyid: jwk.kid, ...(agent_url !== undefined && { agent_url }), verified_at: now };
}

function requireParams(parsed: ParsedSignatureInput): void {
  const required: Array<keyof ParsedSignatureInput['params']> = ['created', 'expires', 'nonce', 'keyid', 'alg', 'tag'];
  const missing = required.filter(k => parsed.params[k] === undefined);
  if (missing.length) {
    throw new ResponseSignatureError(
      'response_signature_params_incomplete',
      2,
      `Signature-Input missing required parameter(s): ${missing.join(', ')}.`
    );
  }
}

function validateWindow(created: number, expires: number, now: number): void {
  // Same shape as webhook: every window failure (expired, negative window,
  // over-long window, created-in-future) folds to a single code. Specific
  // subtype lives in the error message for diagnostics.
  if (expires <= created) {
    throw new ResponseSignatureError(
      'response_signature_window_invalid',
      5,
      'Signature expires must be strictly greater than created.'
    );
  }
  if (expires - created > MAX_SIGNATURE_WINDOW_SECONDS) {
    throw new ResponseSignatureError(
      'response_signature_window_invalid',
      5,
      `Signature window exceeds ${MAX_SIGNATURE_WINDOW_SECONDS}s maximum.`
    );
  }
  if (now < created - CLOCK_SKEW_TOLERANCE_SECONDS) {
    throw new ResponseSignatureError(
      'response_signature_window_invalid',
      5,
      'Signature created is in the future beyond skew tolerance.'
    );
  }
  if (now > expires + CLOCK_SKEW_TOLERANCE_SECONDS) {
    throw new ResponseSignatureError('response_signature_window_invalid', 5, 'Signature is expired.');
  }
}

function validateCoveredComponents(components: string[], body: string | undefined): void {
  for (const mandatory of RESPONSE_MANDATORY_COMPONENTS) {
    if (!components.includes(mandatory)) {
      throw new ResponseSignatureError(
        'response_signature_components_incomplete',
        6,
        `Covered components must include "${mandatory}".`
      );
    }
  }
  // When the response carries a body, `content-digest` coverage is required
  // — an unbound body is the cross-purpose footgun the signer's default
  // opt-out behavior is designed to prevent. The signer omits
  // content-digest only when the body is empty (e.g. 204 No Content); the
  // verifier mirrors that envelope.
  const hasBody = (body ?? '').length > 0;
  if (hasBody && !components.includes('content-digest')) {
    throw new ResponseSignatureError(
      'response_signature_components_incomplete',
      6,
      'Response carries a body but "content-digest" is not in covered components.'
    );
  }
}

/**
 * Syntactic validation of the originating-request `@target-uri` value. Four
 * failure modes mirror the webhook verifier:
 *   - URL doesn't parse at all.
 *   - Scheme is not https (response signatures bound to http will fail
 *     strict-HTTPS verifier profiles; loopback hosts are exempt for local
 *     test mock servers).
 *   - Authority contains userinfo — credentials don't belong in a signed URI.
 *   - URL carries a fragment — fragments are client-side and never transmitted.
 *
 * Each throws `response_target_uri_malformed`. The error message names the
 * failure reason.
 */
function validateTargetUri(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ResponseSignatureError(
      'response_target_uri_malformed',
      6,
      `@target-uri "${rawUrl}" is not a parseable URL.`
    );
  }
  if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) {
    throw new ResponseSignatureError(
      'response_target_uri_malformed',
      6,
      `@target-uri must use https; got "${url.protocol}" in "${rawUrl}".`
    );
  }
  if (url.username || url.password) {
    throw new ResponseSignatureError('response_target_uri_malformed', 6, '@target-uri must not embed userinfo.');
  }
  if (url.hash) {
    throw new ResponseSignatureError('response_target_uri_malformed', 6, '@target-uri must not carry a fragment.');
  }
}

function isLoopbackHost(hostname: string): boolean {
  if (!hostname) return false;
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.');
}

/**
 * Options for {@link createResponseVerifier}. Identical to
 * {@link VerifyResponseOptions} except `replayStore` and `revocationStore`
 * are optional — the factory defaults them once at creation time so replay
 * state is shared across every response the returned verifier handles.
 */
export interface CreateResponseVerifierOptions extends Omit<VerifyResponseOptions, 'replayStore' | 'revocationStore'> {
  /**
   * Stores `(keyid, scope, nonce)` tuples for replay detection. Defaults to
   * a fresh {@link InMemoryReplayStore} — suitable for single-process
   * deployments only. **Multi-replica deployments MUST pass an explicit
   * shared store** (Redis, Postgres, etc.); the default in-memory store
   * does not survive process boundaries, so a signature accepted on
   * replica A is invisible to replica B and can be replayed there within
   * the signature window.
   */
  replayStore?: ReplayStore;
  /**
   * Consulted for revoked `kid` before accepting a signature. Defaults to a
   * fresh {@link InMemoryRevocationStore}, which starts empty and does not
   * poll for updates. Pass a store backed by your secrets manager or admin
   * tooling when you revoke keys at runtime.
   */
  revocationStore?: RevocationStore;
}

/**
 * Create a bound response-signature verifier with shared replay and
 * revocation stores. Mirrors {@link createWebhookVerifier} for the response
 * profile.
 *
 * **Why a factory?** Replay detection requires the same store instance to
 * be consulted across every response. Constructing stores inside a
 * per-response call would silently defeat replay dedup. The factory pattern
 * captures stores in closure scope at wire-up time.
 *
 * **Multi-replica deployments MUST pass an explicit `replayStore`** backed
 * by a shared persistence layer.
 */
export function createResponseVerifier(
  options: CreateResponseVerifierOptions
): (response: ResponseLike) => Promise<VerifyResponseResult> {
  const replayStore = options.replayStore ?? new InMemoryReplayStore();
  const revocationStore = options.revocationStore ?? new InMemoryRevocationStore();
  return (response: ResponseLike) => verifyResponseSignature(response, { ...options, replayStore, revocationStore });
}
