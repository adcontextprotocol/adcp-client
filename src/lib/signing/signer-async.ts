import type { RequestLike } from './canonicalize';
import type { SigningProvider } from './provider';
import type { SignedRequest, SignRequestOptions, SignWebhookOptions } from './signer';
import { finalizeRequestSignature, prepareRequestSignature, prepareWebhookSignature } from './signer';

/**
 * Async variant of `signRequest` that delegates the actual signature
 * production to a {@link SigningProvider}. Reuses
 * {@link prepareRequestSignature} and {@link finalizeRequestSignature} from
 * the sync path so canonicalization cannot drift between the two —
 * `provider.sign(payload)` is the only difference, and it may dispatch to
 * KMS / HSM / Vault and add 10–50 ms of network latency per call.
 *
 * Callers that hold a private JWK in process should keep using the sync
 * `signRequest` for lower per-call cost; this entry point is for production
 * deployments that store private keys in a managed key store.
 */
export async function signRequestAsync(
  request: RequestLike,
  provider: SigningProvider,
  options: SignRequestOptions = {}
): Promise<SignedRequest> {
  const prepared = prepareRequestSignature(request, { keyid: provider.keyid, alg: provider.algorithm }, options);
  const signature = await provider.sign(Buffer.from(prepared.base, 'utf8'));
  return finalizeRequestSignature(prepared, signature);
}

/**
 * Async variant of `signWebhook`. Reuses {@link prepareWebhookSignature}
 * and {@link finalizeRequestSignature} from the sync path so the five
 * mandatory components, `adcp/webhook-signing/v1` tag, and unconditional
 * `Content-Digest` header stay in lockstep.
 */
export async function signWebhookAsync(
  request: RequestLike,
  provider: SigningProvider,
  options: SignWebhookOptions = {}
): Promise<SignedRequest> {
  const prepared = prepareWebhookSignature(request, { keyid: provider.keyid, alg: provider.algorithm }, options);
  const signature = await provider.sign(Buffer.from(prepared.base, 'utf8'));
  return finalizeRequestSignature(prepared, signature);
}
