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
export { signRequest, type SignedRequest, type SignerKey, type SignRequestOptions } from './signer';
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
  extractAdcpOperation,
  resolveCoverContentDigest,
  shouldSignOperation,
  toSignerKey,
  type BuildAgentSigningFetchOptions,
} from './agent-fetch';
export { buildAgentSigningContext, type AgentSigningContext } from './agent-context';
export { ensureCapabilityLoaded, CAPABILITY_OP } from './capability-priming';
