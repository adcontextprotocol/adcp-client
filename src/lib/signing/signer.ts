import { createPrivateKey, randomBytes, sign as nodeSign, type JsonWebKey } from 'crypto';
import { buildSignatureBase, formatSignatureParams, type RequestLike, type SignatureParams } from './canonicalize';
import { computeContentDigest } from './content-digest';
import { MANDATORY_COMPONENTS, MAX_SIGNATURE_WINDOW_SECONDS, REQUEST_SIGNING_TAG, type AdcpJsonWebKey } from './types';
import { WEBHOOK_MANDATORY_COMPONENTS, WEBHOOK_SIGNING_TAG } from './webhook-verifier';

export interface SignerKey {
  keyid: string;
  alg: 'ed25519' | 'ecdsa-p256-sha256';
  privateKey: AdcpJsonWebKey;
}

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

export function signRequest(request: RequestLike, key: SignerKey, options: SignRequestOptions = {}): SignedRequest {
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
    keyid: key.keyid,
    alg: key.alg,
    tag: REQUEST_SIGNING_TAG,
  };

  const normalizedRequest: RequestLike = { ...request, headers };
  const base = buildSignatureBase(components, normalizedRequest, params);

  const signature = produceSignature(key, Buffer.from(base, 'utf8'));
  // Emit base64url without padding to match the AdCP conformance-vector
  // format (and deterministic Ed25519 sigs are then byte-identical across
  // SDKs). Verifiers accept either variant since Node's base64 decoder
  // treats `+`/`-` and `/`/`_` interchangeably.
  const sigB64 = Buffer.from(signature).toString('base64url');

  headers['Signature-Input'] = `${label}=${formatSignatureParams(components, params)}`;
  headers['Signature'] = `${label}=:${sigB64}:`;

  return { headers, signatureBase: base, params };
}

export interface SignWebhookOptions {
  label?: string;
  windowSeconds?: number;
  now?: () => number;
  nonce?: string;
}

/**
 * Sign an outbound webhook request under the RFC 9421 webhook profile
 * (`tag=adcp/webhook-signing/v1`). Covers the five mandatory components —
 * `@method`, `@target-uri`, `@authority`, `content-type`, `content-digest` —
 * and sets `Content-Digest` on the outgoing headers. Publishers emitting
 * conformant webhooks should use this instead of hand-rolling signatures.
 */
export function signWebhook(request: RequestLike, key: SignerKey, options: SignWebhookOptions = {}): SignedRequest {
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
    keyid: key.keyid,
    alg: key.alg,
    tag: WEBHOOK_SIGNING_TAG,
  };

  const normalizedRequest: RequestLike = { ...request, headers };
  const base = buildSignatureBase(components, normalizedRequest, params);
  const signature = produceSignature(key, Buffer.from(base, 'utf8'));
  const sigB64 = Buffer.from(signature).toString('base64url');

  headers['Signature-Input'] = `${label}=${formatSignatureParams(components, params)}`;
  headers['Signature'] = `${label}=:${sigB64}:`;
  return { headers, signatureBase: base, params };
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
