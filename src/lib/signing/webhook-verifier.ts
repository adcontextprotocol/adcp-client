/**
 * RFC 9421 webhook-signing verifier (AdCP 3.0 webhook profile).
 *
 * Companion to `verifier.ts`, which verifies outbound request signatures.
 * This verifier runs on the receiving side of a publisher webhook: the
 * storyboard runner's receiver captures a POST and hands the request (headers
 * + raw body) here for signature validation.
 *
 * Distinct from request-signing:
 *   - Tag: `adcp/webhook-signing/v1` (vs `adcp/request-signing/v1`).
 *   - Key purpose: `adcp_use: "webhook-signing"` (vs `"request-signing"`).
 *   - Covered components MUST include `@method`, `@target-uri`, `@authority`,
 *     `content-type`, and `content-digest` — `content-digest` is unconditional
 *     for webhooks (vs policy-driven on requests) because every webhook
 *     carries a JSON body.
 *   - JWKS resolved via the publisher's `brand.json` `agents[]` `jwks_uri`,
 *     not the request-path capability document.
 *
 * Checklist steps below mirror the 14-step shape in
 * `docs/building/implementation/security.mdx#verifier-checklist-for-webhooks`
 * so failures can point at a specific spec clause. Numbers are 1-based to
 * match the security doc.
 */

import { buildSignatureBase, getHeaderValue, type RequestLike } from './canonicalize';
import { contentDigestMatches } from './content-digest';
import { RequestSignatureError, WebhookSignatureError } from './errors';
import { parseSignature, parseSignatureInput, type ParsedSignatureInput } from './parser';
import { jwkToPublicKey, verifySignature } from './crypto';
import type { JwksResolver } from './jwks';
import type { ReplayStore } from './replay';
import type { RevocationStore } from './revocation';
import { ALLOWED_ALGS, CLOCK_SKEW_TOLERANCE_SECONDS, MAX_SIGNATURE_WINDOW_SECONDS } from './types';

export const WEBHOOK_SIGNING_TAG = 'adcp/webhook-signing/v1';

/**
 * Covered-component minimum for webhooks. Unlike request-signing, every
 * webhook carries a body so `content-type` and `content-digest` are
 * unconditional — a webhook without `content-digest` coverage can't be
 * verified because the body has no anchor.
 */
export const WEBHOOK_MANDATORY_COMPONENTS: ReadonlyArray<string> = [
  '@method',
  '@target-uri',
  '@authority',
  'content-type',
  'content-digest',
];

export interface VerifyWebhookOptions {
  jwks: JwksResolver;
  replayStore: ReplayStore;
  revocationStore: RevocationStore;
  /** Now in seconds since epoch. Defaults to `Date.now() / 1000`. */
  now?: () => number;
  /**
   * Optional tag override — spec currently defines exactly
   * `adcp/webhook-signing/v1`; the override lets test vectors pin a version.
   */
  requiredTag?: string;
  /** Optional reverse-lookup (kid → publisher URL) for result attribution. */
  agentUrlForKeyid?: (keyid: string) => string | undefined;
}

export interface VerifyWebhookResult {
  status: 'verified';
  keyid: string;
  agent_url?: string;
  verified_at: number;
}

/**
 * Verify an inbound webhook's RFC 9421 signature.
 *
 * Checklist steps 1–13 plus sub-step 9a, matching the canonical numbering
 * in `security.mdx#verifier-checklist-for-webhooks` (and the `failed_step`
 * values on the conformance vectors at
 * `test-vectors/webhook-signing/negative/`). Throws
 * `WebhookSignatureError` on the first failed step.
 *
 * Ordering invariant: cheap invariant checks (tag, alg, window, components)
 * run before JWKS resolution (step 7); revocation (9) and rate-abuse (9a)
 * run before cryptographic verify (10) so an attacker can't amplify
 * Ed25519/ECDSA work. Replay insert (13) commits only after every earlier
 * step has passed — any signature failing at step 10 never consumes a cap
 * entry, so external traffic can't grow the per-keyid cache.
 */
export async function verifyWebhookSignature(
  request: RequestLike,
  options: VerifyWebhookOptions
): Promise<VerifyWebhookResult> {
  const now = options.now ? options.now() : Math.floor(Date.now() / 1000);
  const requiredTag = options.requiredTag ?? WEBHOOK_SIGNING_TAG;

  // Step 1: both signature headers present AND parseable. The bound-pair
  // rule (`Signature` without `Signature-Input` or vice versa) rejects here.
  const sigInputHeader = getHeaderValue(request.headers, 'Signature-Input');
  const sigHeader = getHeaderValue(request.headers, 'Signature');
  if (!sigInputHeader || !sigHeader) {
    throw new WebhookSignatureError(
      'webhook_signature_header_malformed',
      1,
      'Webhook is missing Signature or Signature-Input headers.'
    );
  }
  let parsedInput: ParsedSignatureInput;
  let parsedSig: ReturnType<typeof parseSignature>;
  try {
    parsedInput = parseSignatureInput(sigInputHeader);
    parsedSig = parseSignature(sigHeader, parsedInput.label);
  } catch (err) {
    throw new WebhookSignatureError(
      'webhook_signature_header_malformed',
      1,
      err instanceof Error ? err.message : String(err)
    );
  }

  // Step 2: required params present.
  requireParams(parsedInput);

  // Step 3: tag match.
  if (parsedInput.params.tag !== requiredTag) {
    throw new WebhookSignatureError(
      'webhook_signature_tag_invalid',
      3,
      `Signature tag must be "${requiredTag}"; got "${parsedInput.params.tag}".`
    );
  }

  // Step 4: alg allowlist.
  if (!ALLOWED_ALGS.has(parsedInput.params.alg)) {
    throw new WebhookSignatureError(
      'webhook_signature_alg_not_allowed',
      4,
      `Signature alg "${parsedInput.params.alg}" is not in the AdCP allowlist.`
    );
  }

  // Step 5: window valid.
  validateWindow(parsedInput.params.created, parsedInput.params.expires, now);

  // Step 6: covered components.
  validateCoveredComponents(parsedInput.components);

  // Step 7: resolve keyid.
  const jwk = await options.jwks.resolve(parsedInput.params.keyid);
  if (!jwk) {
    throw new WebhookSignatureError(
      'webhook_signature_key_unknown',
      7,
      `No JWK found for keyid "${parsedInput.params.keyid}".`
    );
  }
  if (jwk.kid !== parsedInput.params.keyid) {
    throw new WebhookSignatureError(
      'webhook_signature_key_unknown',
      7,
      `JWKS resolver returned a JWK whose kid "${jwk.kid}" does not match requested keyid "${parsedInput.params.keyid}".`
    );
  }

  // Step 8: key purpose — MUST be scoped for webhook signing.
  if (jwk.adcp_use !== 'webhook-signing' || !jwk.key_ops?.includes('verify')) {
    throw new WebhookSignatureError(
      'webhook_signature_key_purpose_invalid',
      8,
      `JWK "${jwk.kid}" is not scoped for webhook-signing verification.`
    );
  }

  // Step 9: revocation. Shared store throws `request_signature_revocation_stale`
  // when its cached snapshot is past grace — re-map to the webhook taxonomy
  // so callers see a consistent error surface.
  try {
    if (await options.revocationStore.isRevoked(jwk.kid)) {
      throw new WebhookSignatureError('webhook_signature_key_revoked', 9, `JWK "${jwk.kid}" is revoked.`);
    }
  } catch (err) {
    if (err instanceof RequestSignatureError && err.code === 'request_signature_revocation_stale') {
      throw new WebhookSignatureError('webhook_signature_revocation_stale', 9, err.message);
    }
    throw err;
  }

  // Step 9a: per-keyid rate abuse. Distinct code from step 12's replay —
  // cap exhaustion is a compromised-key / misconfig signal that SHOULD
  // alert operators, not "same nonce twice."
  if (await options.replayStore.isCapHit(jwk.kid, now)) {
    throw new WebhookSignatureError(
      'webhook_signature_rate_abuse',
      9,
      `Per-keyid replay cache cap exceeded for keyid=${jwk.kid}.`
    );
  }

  // Pre-check step 12's replay before crypto so a replayed nonce short-
  // circuits an expensive Ed25519/ECDSA verify.
  if (await options.replayStore.has(jwk.kid, parsedInput.params.nonce, now)) {
    throw new WebhookSignatureError(
      'webhook_signature_replayed',
      12,
      `Replay of (keyid=${jwk.kid}, nonce=${parsedInput.params.nonce}) within signature window.`
    );
  }

  // Step 10: cryptographic verify.
  const base = buildSignatureBase(
    parsedInput.components,
    request,
    parsedInput.params,
    parsedInput.signatureParamsValue
  );
  const publicKey = jwkToPublicKey(jwk);
  const valid = verifySignature(parsedInput.params.alg, publicKey, Buffer.from(base, 'utf8'), parsedSig.bytes);
  if (!valid) {
    throw new WebhookSignatureError(
      'webhook_signature_invalid',
      10,
      'Cryptographic verification of webhook signature base failed.'
    );
  }

  // Step 11: content-digest match.
  const digestHeader = getHeaderValue(request.headers, 'Content-Digest');
  if (!digestHeader || !contentDigestMatches(digestHeader, request.body ?? '')) {
    throw new WebhookSignatureError(
      'webhook_signature_digest_mismatch',
      11,
      'Content-Digest header does not match recomputed body hash.'
    );
  }

  // Step 13: commit nonce. Insert AFTER every prior check passes — this is
  // the load-bearing invariant that keeps external traffic from growing the
  // cap (any signature failing at step 10 never consumes an entry).
  const remaining = parsedInput.params.expires - now + CLOCK_SKEW_TOLERANCE_SECONDS;
  const ttl = Math.max(remaining, MAX_SIGNATURE_WINDOW_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS);
  const insertResult = await options.replayStore.insert(jwk.kid, parsedInput.params.nonce, ttl, now);
  if (insertResult === 'replayed') {
    throw new WebhookSignatureError(
      'webhook_signature_replayed',
      13,
      `Replay of (keyid=${jwk.kid}, nonce=${parsedInput.params.nonce}) within signature window.`
    );
  }
  if (insertResult === 'rate_abuse') {
    throw new WebhookSignatureError(
      'webhook_signature_rate_abuse',
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
    throw new WebhookSignatureError(
      'webhook_signature_params_incomplete',
      2,
      `Signature-Input missing required parameter(s): ${missing.join(', ')}.`
    );
  }
}

function validateWindow(created: number, expires: number, now: number): void {
  // Spec folds every window-level failure — expired, negative window,
  // over-long window, created-in-future — into webhook_signature_window_invalid.
  // The error message carries the specific subtype for diagnostics.
  if (expires <= created) {
    throw new WebhookSignatureError(
      'webhook_signature_window_invalid',
      5,
      'Signature expires must be strictly greater than created.'
    );
  }
  if (expires - created > MAX_SIGNATURE_WINDOW_SECONDS) {
    throw new WebhookSignatureError(
      'webhook_signature_window_invalid',
      5,
      `Signature window exceeds ${MAX_SIGNATURE_WINDOW_SECONDS}s maximum.`
    );
  }
  if (now < created - CLOCK_SKEW_TOLERANCE_SECONDS) {
    throw new WebhookSignatureError(
      'webhook_signature_window_invalid',
      5,
      'Signature created is in the future beyond skew tolerance.'
    );
  }
  if (now > expires + CLOCK_SKEW_TOLERANCE_SECONDS) {
    throw new WebhookSignatureError('webhook_signature_window_invalid', 5, 'Signature is expired.');
  }
}

function validateCoveredComponents(components: string[]): void {
  for (const mandatory of WEBHOOK_MANDATORY_COMPONENTS) {
    if (!components.includes(mandatory)) {
      throw new WebhookSignatureError(
        'webhook_signature_components_incomplete',
        6,
        `Covered components must include "${mandatory}".`
      );
    }
  }
}
