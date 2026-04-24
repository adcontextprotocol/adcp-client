/**
 * Client-side signing surface: what a buyer needs to sign outbound AdCP
 * requests per RFC 9421 — signer, canonicalization helpers, fetch wrapper,
 * and the capability cache that gates auto-wiring.
 *
 * Paired with `@adcp/client/signing/server` (verifier / middleware / stores).
 * The aggregate `@adcp/client/signing` barrel re-exports both for back-compat.
 */
export {
  buildSignatureBase,
  canonicalAuthority,
  canonicalMethod,
  canonicalTargetUri,
  formatSignatureParams,
  getHeaderValue,
  type RequestLike,
  type SignatureParams,
} from './canonicalize';
export { computeContentDigest, contentDigestMatches, parseContentDigest } from './content-digest';
export {
  signRequest,
  signWebhook,
  type SignedRequest,
  type SignerKey,
  type SignRequestOptions,
  type SignWebhookOptions,
} from './signer';
export { WEBHOOK_MANDATORY_COMPONENTS, WEBHOOK_SIGNING_TAG } from './webhook-verifier';
export { createSigningFetch, type CoverContentDigestPredicate, type SigningFetchOptions } from './fetch';
export {
  ALLOWED_ALGS,
  CLOCK_SKEW_TOLERANCE_SECONDS,
  MANDATORY_COMPONENTS,
  MAX_SIGNATURE_WINDOW_SECONDS,
  REQUEST_SIGNING_TAG,
  type AdcpJsonWebKey,
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
  resolveCoverContentDigest,
  shouldSignOperation,
  toSignerKey,
  type BuildAgentSigningFetchOptions,
  type CreateAgentSignedFetchOptions,
} from './agent-fetch';
export { buildAgentSigningContext, signingContextStorage, type AgentSigningContext } from './agent-context';
export { ensureCapabilityLoaded, CAPABILITY_OP } from './capability-priming';
