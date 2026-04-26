import { randomBytes } from 'crypto';
import { buildSignatureBase, formatSignatureParams, type RequestLike, type SignatureParams } from './canonicalize';
import { computeContentDigest } from './content-digest';
import type { SigningProvider } from './provider';
import { MANDATORY_COMPONENTS, MAX_SIGNATURE_WINDOW_SECONDS, REQUEST_SIGNING_TAG } from './types';
import type { SignedRequest, SignRequestOptions, SignWebhookOptions } from './signer';
import { WEBHOOK_MANDATORY_COMPONENTS, WEBHOOK_SIGNING_TAG } from './webhook-verifier';

/**
 * Async variant of `signRequest` that delegates the actual signature
 * production to a {@link SigningProvider}. The signature-base canonicalization
 * is identical to the sync path — the only difference is that
 * `provider.sign(payload)` may dispatch to KMS / HSM / Vault and adds
 * 10–50 ms of network latency per call.
 *
 * Callers that hold a private JWK in process should keep using the sync
 * `signRequest` for lower per-call cost; this entry point is for production
 * deployments that store private keys in a managed key store.
 *
 * Keep in sync with `signRequest` in `./signer.ts` — the signature-base
 * canonicalization, default windowing, nonce generation, and content-digest
 * gating are byte-for-byte parallel. The async variant is duplicated rather
 * than refactored to a shared core so the sync hot path stays unchanged.
 */
export async function signRequestAsync(
  request: RequestLike,
  provider: SigningProvider,
  options: SignRequestOptions = {}
): Promise<SignedRequest> {
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
    keyid: provider.keyid,
    alg: provider.algorithm,
    tag: REQUEST_SIGNING_TAG,
  };

  const normalizedRequest: RequestLike = { ...request, headers };
  const base = buildSignatureBase(components, normalizedRequest, params);

  const signature = await provider.sign(Buffer.from(base, 'utf8'));
  const sigB64 = Buffer.from(signature).toString('base64url');

  headers['Signature-Input'] = `${label}=${formatSignatureParams(components, params)}`;
  headers['Signature'] = `${label}=:${sigB64}:`;

  return { headers, signatureBase: base, params };
}

/**
 * Async variant of `signWebhook`. Same five mandatory components and
 * `adcp/webhook-signing/v1` tag as the sync path; differs only in routing
 * the signature production through a {@link SigningProvider}.
 *
 * Keep in sync with `signWebhook` in `./signer.ts`.
 */
export async function signWebhookAsync(
  request: RequestLike,
  provider: SigningProvider,
  options: SignWebhookOptions = {}
): Promise<SignedRequest> {
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
    keyid: provider.keyid,
    alg: provider.algorithm,
    tag: options.tag ?? WEBHOOK_SIGNING_TAG,
  };

  const normalizedRequest: RequestLike = { ...request, headers };
  const base = buildSignatureBase(components, normalizedRequest, params);
  const signature = await provider.sign(Buffer.from(base, 'utf8'));
  const sigB64 = Buffer.from(signature).toString('base64url');

  headers['Signature-Input'] = `${label}=${formatSignatureParams(components, params)}`;
  headers['Signature'] = `${label}=:${sigB64}:`;
  return { headers, signatureBase: base, params };
}

function flattenHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.map(entry => entry.trim()).join(', ') : v.trim();
  }
  return out;
}

function base64UrlRandom(byteLength: number): string {
  return randomBytes(byteLength).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
