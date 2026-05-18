/**
 * Client-side signing surface: what a buyer needs to sign outbound AdCP
 * requests per RFC 9421 — signer, canonicalization helpers, fetch wrapper,
 * and the capability cache that gates auto-wiring.
 *
 * Paired with `@adcp/sdk/signing/server` (verifier / middleware / stores).
 * The aggregate `@adcp/sdk/signing` barrel re-exports both for back-compat.
 */
export {
  buildResponseSignatureBase,
  buildSignatureBase,
  canonicalAuthority,
  canonicalMethod,
  canonicalTargetUri,
  formatSignatureParams,
  getHeaderValue,
  type RequestLike,
  type ResponseLike,
  type SignatureParams,
} from './canonicalize';
export { computeContentDigest, contentDigestMatches, parseContentDigest } from './content-digest';
export {
  requestContextFromExpress,
  requestContextFromFetch,
  requestContextFromLambda,
  type ExpressRequestLike,
  type FetchRequestLike,
  type LambdaRequestEvent,
  type RequestContextFromExpressOptions,
  type RequestContextFromLambdaOptions,
} from './request-context';
export {
  finalizeRequestSignature,
  finalizeResponseSignature,
  prepareRequestSignature,
  prepareResponseSignature,
  prepareWebhookSignature,
  signRequest,
  signResponse,
  signWebhook,
  type PreparedRequestSignature,
  type PreparedResponseSignature,
  type SignatureIdentity,
  type SignedRequest,
  type SignedResponse,
  type SignerKey,
  type SignRequestOptions,
  type SignResponseOptions,
  type SignWebhookOptions,
} from './signer';
export { signRequestAsync, signResponseAsync, signWebhookAsync } from './signer-async';
export { derEcdsaToP1363 } from './ecdsa-encoding';
export { WEBHOOK_MANDATORY_COMPONENTS, WEBHOOK_SIGNING_TAG } from './webhook-verifier';
export { createSigningFetch, type CoverContentDigestPredicate, type SigningFetchOptions } from './fetch';
export { createSigningFetchAsync } from './fetch-async';
export type { SigningProvider } from './provider';
export {
  RequestSignatureError,
  type RequestSignatureErrorCode,
  ResponseSignatureError,
  type ResponseSignatureErrorCode,
  SigningProviderAlgorithmMismatchError,
  type SigningProviderErrorCode,
  WebhookSignatureError,
  type WebhookSignatureErrorCode,
} from './errors';
export {
  ALLOWED_ALGS,
  CLOCK_SKEW_TOLERANCE_SECONDS,
  MANDATORY_COMPONENTS,
  MAX_SIGNATURE_WINDOW_SECONDS,
  REQUEST_SIGNING_TAG,
  RESPONSE_MANDATORY_COMPONENTS,
  RESPONSE_SIGNING_TAG,
  type AdcpJsonWebKey,
  type AdcpSignAlg,
  type ContentDigestPolicy,
  type VerifierCapability,
} from './types';
export {
  CapabilityCache,
  buildCapabilityCacheKey,
  defaultCapabilityCache,
  type CachedCapability,
  type CapabilityCacheOptions,
} from './capability-cache';
export {
  buildAgentSigningFetch,
  createAgentSignedFetch,
  extractAdcpOperation,
  isInlineSigningConfig,
  isProviderSigningConfig,
  resolveCoverContentDigest,
  shouldSignOperation,
  toSignerKey,
  type BuildAgentSigningFetchOptions,
  type CreateAgentSignedFetchOptions,
} from './agent-fetch';
export {
  buildAgentSigningContext,
  signingContextStorage,
  type AgentSigningContext,
  type AgentSigningIdentitySnapshot,
} from './agent-context';
export { ensureCapabilityLoaded, CAPABILITY_OP } from './capability-priming';
export { pemToAdcpJwk, type AdcpUse, type PemToAdcpJwkOptions } from './jwks-helpers';
