import { createPrivateKey, randomBytes, sign as nodeSign, type JsonWebKey } from 'crypto';
import { buildSignatureBase, formatSignatureParams, type RequestLike, type SignatureParams } from './canonicalize';
import { computeContentDigest } from './content-digest';
import { RequestSignatureError, WebhookSignatureError } from './errors';
import type { AdcpUse } from './jwks-helpers';
import {
  MANDATORY_COMPONENTS,
  MAX_SIGNATURE_WINDOW_SECONDS,
  REQUEST_SIGNING_TAG,
  type AdcpJsonWebKey,
  type AdcpSignAlg,
} from './types';
import { WEBHOOK_MANDATORY_COMPONENTS, WEBHOOK_SIGNING_TAG } from './webhook-verifier';

export interface SignerKey {
  keyid: string;
  alg: 'ed25519' | 'ecdsa-p256-sha256';
  /**
   * Private JWK. MUST carry `adcp_use` matching the helper being called:
   * - `signRequest` requires `adcp_use: 'request-signing'`
   * - `signWebhook` requires `adcp_use: 'webhook-signing'`
   *
   * Mismatched or missing `adcp_use` throws at the signer with the same
   * error code the verifier raises at step 8 — failure surfaces at
   * configuration time rather than at the receiver, where the message is
   * far from its cause. Mint keys with `pemToAdcpJwk({ adcp_use: ... })`
   * to get the binding right by construction.
   */
  privateKey: AdcpJsonWebKey;
}

/**
 * Step-8-equivalent purpose-binding gate on the signer side. The verifier
 * already enforces `jwk.adcp_use === expected` at step 8 (see verifier.ts
 * for request signing; webhook-verifier.ts for webhooks). Replicating the
 * check on the signer side prevents the more common operator footgun:
 * passing a wrong-purpose key into the helper, producing a wire-conformant
 * signature that the downstream verifier then rejects, surfacing the
 * misconfiguration at the wrong end of the connection.
 *
 * Errors emit the same code the verifier uses for that direction so log
 * scrapers across signer / verifier see consistent vocabulary.
 */
/**
 * Subset of {@link AdcpUse} that the RFC 9421 helpers in this module emit
 * as `expected`. Governance signing is JWS-based and lives on a different
 * code path; narrowing the parameter here lets the exhaustiveness branch
 * stay tight without a `case 'governance-signing':` arm that throws an
 * untyped error. A future JWS helper would mint its own typed error class
 * rather than route through `throwIfPurposeMismatch`.
 */
type Rfc9421AdcpUse = Exclude<AdcpUse, 'governance-signing'>;

function assertKeyPurpose(key: SignerKey, expected: Rfc9421AdcpUse): void {
  throwIfPurposeMismatch(key.keyid, key.privateKey.adcp_use, expected);
}

/**
 * Async-path equivalent. Mirrors {@link assertKeyPurpose} but reads
 * `adcpUse` from a {@link SigningProvider} rather than a `SignerKey`.
 *
 * **Optional binding.** When `provider.adcpUse` is `undefined`, the gate
 * is skipped — preserves backward compat with adapters that pre-date the
 * `SigningProvider.adcpUse` field. Adapter authors who want signer-side
 * defense-in-depth set `adcpUse` on their provider; the async helpers
 * (`signRequestAsync` / `signWebhookAsync`) then enforce the binding
 * parallel to the sync path.
 */
function assertProviderPurpose(
  provider: { readonly keyid: string; readonly adcpUse?: string },
  expected: Rfc9421AdcpUse
): void {
  if (provider.adcpUse === undefined) return;
  throwIfPurposeMismatch(provider.keyid, provider.adcpUse, expected);
}

function throwIfPurposeMismatch(keyid: string, actual: string | undefined, expected: Rfc9421AdcpUse): void {
  if (actual === expected) return;
  const message =
    `Signing key '${keyid}' has adcp_use=${actual === undefined ? '<missing>' : `'${actual}'`} ` +
    `but the helper requires '${expected}'. Mint a key scoped for '${expected}' via ` +
    `pemToAdcpJwk({ adcp_use: '${expected}' }) — sharing keys across purposes is intentionally refused.`;
  switch (expected) {
    case 'request-signing':
      throw new RequestSignatureError('request_signature_key_purpose_invalid', 8, message);
    case 'webhook-signing':
      throw new WebhookSignatureError('webhook_signature_key_purpose_invalid', 8, message);
    default: {
      // Compile-time exhaustiveness: a future widening of `Rfc9421AdcpUse`
      // (typically because `AdcpUse` grew an RFC-9421 member) must add a
      // case arm here. Trips `tsc --noEmit` if the union grows without an
      // explicit gate decision for the new member.
      const _exhaustive: never = expected;
      throw new Error(`unreachable: unhandled Rfc9421AdcpUse '${_exhaustive}'`);
    }
  }
}

export { assertProviderPurpose };

export interface SignRequestOptions {
  coverContentDigest?: boolean;
  label?: string;
  windowSeconds?: number;
  now?: () => number;
  nonce?: string;
}

export interface SignedRequest {
  headers: Record<string, string>;
  signatureBase: string;
  params: SignatureParams;
}

/**
 * Identity fields needed to populate `Signature-Input` parameters. The sync
 * `signRequest` path takes these from a {@link SignerKey}; the async path
 * takes them from a `SigningProvider`. Centralizing the shape keeps both
 * canonicalizations identical.
 */
export interface SignatureIdentity {
  keyid: string;
  alg: AdcpSignAlg;
}

/**
 * Result of canonicalizing a request for signing — everything `signRequest`
 * and `signRequestAsync` produce up to (but not including) the call into
 * the signer/provider.
 */
export interface PreparedRequestSignature {
  components: string[];
  params: SignatureParams;
  /**
   * Outbound headers including `Content-Digest` when covered, but not yet
   * including `Signature-Input` / `Signature` — those are appended by
   * {@link finalizeRequestSignature}.
   */
  headers: Record<string, string>;
  /** Canonical signature base bytes (UTF-8). Pass to the signer/provider. */
  base: string;
  label: string;
}

/**
 * Canonicalize a request for RFC 9421 request-signing. Pure (no I/O); the
 * sync and async paths share this so canonicalization can't drift between
 * them.
 *
 * **No purpose-binding gate.** This function takes a `SignatureIdentity`
 * (just `keyid` + `alg`), not a full `SignerKey`, so it deliberately
 * cannot enforce `adcp_use`. Callers composing `prepare* + own-signer`
 * are responsible for purpose binding themselves — the convenience
 * helper `signRequest` runs `assertKeyPurpose` before calling this and
 * is what most adopters want. Test-vector authors who need to sign with
 * wrong-purpose keys (e.g. AdCP negative-vector 009 cross-purpose
 * rejection) use this prepare/finalize composition deliberately.
 */
export function prepareRequestSignature(
  request: RequestLike,
  identity: SignatureIdentity,
  options: SignRequestOptions = {}
): PreparedRequestSignature {
  const now = options.now ? options.now() : Math.floor(Date.now() / 1000);
  const windowSeconds = Math.min(options.windowSeconds ?? 300, MAX_SIGNATURE_WINDOW_SECONDS);
  const nonce = options.nonce ?? base64UrlRandom(16);
  const label = options.label ?? 'sig1';
  const hasBody = (request.body ?? '').length > 0;

  const coverDigest = options.coverContentDigest === true && hasBody;
  const headers: Record<string, string> = { ...flattenHeaders(request.headers) };
  if (coverDigest) {
    headers['Content-Digest'] = computeContentDigest(request.body ?? '');
  }

  const components = [...MANDATORY_COMPONENTS];
  if (hasBody) components.push('content-type');
  if (coverDigest) components.push('content-digest');

  const params: SignatureParams = {
    created: now,
    expires: now + windowSeconds,
    nonce,
    keyid: identity.keyid,
    alg: identity.alg,
    tag: REQUEST_SIGNING_TAG,
  };

  const normalizedRequest: RequestLike = { ...request, headers };
  const base = buildSignatureBase(components, normalizedRequest, params);

  return { components, params, headers, base, label };
}

/**
 * Attach `Signature` / `Signature-Input` headers given the bytes returned
 * by the signer/provider. Shared between the sync and async paths so the
 * base64url emission stays canonical.
 *
 * Emits base64url without padding to match the AdCP conformance-vector
 * format (and deterministic Ed25519 sigs are then byte-identical across
 * SDKs). Verifiers accept either variant since Node's base64 decoder
 * treats `+`/`-` and `/`/`_` interchangeably.
 */
export function finalizeRequestSignature(prepared: PreparedRequestSignature, signature: Uint8Array): SignedRequest {
  const headers = { ...prepared.headers };
  const sigB64 = Buffer.from(signature).toString('base64url');
  headers['Signature-Input'] = `${prepared.label}=${formatSignatureParams(prepared.components, prepared.params)}`;
  headers['Signature'] = `${prepared.label}=:${sigB64}:`;
  return { headers, signatureBase: prepared.base, params: prepared.params };
}

export function signRequest(request: RequestLike, key: SignerKey, options: SignRequestOptions = {}): SignedRequest {
  assertKeyPurpose(key, 'request-signing');
  const prepared = prepareRequestSignature(request, { keyid: key.keyid, alg: key.alg }, options);
  const signature = produceSignature(key, Buffer.from(prepared.base, 'utf8'));
  return finalizeRequestSignature(prepared, signature);
}

export interface SignWebhookOptions {
  label?: string;
  windowSeconds?: number;
  now?: () => number;
  nonce?: string;
  /**
   * Override the signature tag. Defaults to `adcp/webhook-signing/v1`.
   * Exposed so test suites can pin a wrong tag to exercise receiver
   * rejection paths without mutating the signed headers post-hoc.
   */
  tag?: string;
}

/**
 * Canonicalize an outbound webhook request under the RFC 9421 webhook
 * profile. Pure (no I/O); shared between sync `signWebhook` and async
 * `signWebhookAsync` paths. Covers the five mandatory components —
 * `@method`, `@target-uri`, `@authority`, `content-type`, `content-digest` —
 * and sets `Content-Digest` on the outgoing headers.
 *
 * **No purpose-binding gate** — same caveat as
 * {@link prepareRequestSignature}. The convenience helper `signWebhook`
 * runs `assertKeyPurpose` before calling this.
 */
export function prepareWebhookSignature(
  request: RequestLike,
  identity: SignatureIdentity,
  options: SignWebhookOptions = {}
): PreparedRequestSignature {
  const now = options.now ? options.now() : Math.floor(Date.now() / 1000);
  const windowSeconds = Math.min(options.windowSeconds ?? 300, MAX_SIGNATURE_WINDOW_SECONDS);
  const nonce = options.nonce ?? base64UrlRandom(16);
  const label = options.label ?? 'sig1';

  const headers: Record<string, string> = { ...flattenHeaders(request.headers) };
  headers['Content-Digest'] = computeContentDigest(request.body ?? '');

  const components = [...WEBHOOK_MANDATORY_COMPONENTS];
  const params: SignatureParams = {
    created: now,
    expires: now + windowSeconds,
    nonce,
    keyid: identity.keyid,
    alg: identity.alg,
    tag: options.tag ?? WEBHOOK_SIGNING_TAG,
  };

  const normalizedRequest: RequestLike = { ...request, headers };
  const base = buildSignatureBase(components, normalizedRequest, params);

  return { components, params, headers, base, label };
}

/**
 * Sign an outbound webhook request under the RFC 9421 webhook profile
 * (`tag=adcp/webhook-signing/v1`). Covers the five mandatory components —
 * `@method`, `@target-uri`, `@authority`, `content-type`, `content-digest` —
 * and sets `Content-Digest` on the outgoing headers. Publishers emitting
 * conformant webhooks should use this instead of hand-rolling signatures.
 */
export function signWebhook(request: RequestLike, key: SignerKey, options: SignWebhookOptions = {}): SignedRequest {
  assertKeyPurpose(key, 'webhook-signing');
  const prepared = prepareWebhookSignature(request, { keyid: key.keyid, alg: key.alg }, options);
  const signature = produceSignature(key, Buffer.from(prepared.base, 'utf8'));
  return finalizeRequestSignature(prepared, signature);
}

function produceSignature(key: SignerKey, data: Buffer): Uint8Array {
  const privateKey = createPrivateKey({
    key: key.privateKey as JsonWebKey,
    format: 'jwk',
  });
  if (key.alg === 'ed25519') {
    return new Uint8Array(nodeSign(null, data, privateKey));
  }
  return new Uint8Array(nodeSign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' }));
}

function flattenHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    // Trim each entry and use ", " as the joiner so the signer and verifier
    // produce the same canonical value when a header was originally multi-line.
    out[k] = Array.isArray(v) ? v.map(entry => entry.trim()).join(', ') : v.trim();
  }
  return out;
}

function base64UrlRandom(byteLength: number): string {
  return randomBytes(byteLength).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
