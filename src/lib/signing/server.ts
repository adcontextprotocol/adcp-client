/**
 * Server-side signing surface: what a seller running an AdCP agent needs to
 * verify inbound RFC 9421 signatures — verifier pipeline, Express-shaped
 * middleware, pluggable JWKS / replay / revocation stores, and the error
 * taxonomy.
 *
 * Paired with `@adcp/sdk/signing/client` (signer / fetch wrapper /
 * capability cache). The aggregate `@adcp/sdk/signing` barrel re-exports
 * both for back-compat.
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
export { jwkToPublicKey, verifySignature } from './crypto';
export {
  RequestSignatureError,
  type RequestSignatureErrorCode,
  ResponseSignatureError,
  type ResponseSignatureErrorCode,
  WebhookSignatureError,
  type WebhookSignatureErrorCode,
} from './errors';
export { StaticJwksResolver, type JwksResolver } from './jwks';
export { HttpsJwksResolver, type HttpsJwksResolverOptions } from './jwks-https';
export {
  BrandJsonJwksResolver,
  BrandJsonResolverError,
  type BrandAgentType,
  type BrandJsonJwksResolverOptions,
  type BrandJsonResolverErrorCode,
} from './brand-jwks';
export { parseSignature, parseSignatureInput, type ParsedSignature, type ParsedSignatureInput } from './parser';
export {
  InMemoryReplayStore,
  type InMemoryReplayStoreOptions,
  type ReplayInsertResult,
  type ReplayStore,
} from './replay';
export {
  PostgresReplayStore,
  REPLAY_CACHE_MIGRATION,
  getReplayStoreMigration,
  sweepExpiredReplays,
  type PostgresReplayStoreOptions,
  type SweepExpiredReplaysOptions,
} from './postgres-replay-store';
export {
  RedisReplayStore,
  type RedisReplayStoreOptions,
  type ReplayRedisBackendClient,
  type ReplayRedisLikeClient,
} from './redis-replay-store';
export { InMemoryRevocationStore, type RevocationStore } from './revocation';
export { HttpsRevocationStore, type HttpsRevocationStoreOptions } from './revocation-https';
export {
  ALLOWED_ALGS,
  CLOCK_SKEW_TOLERANCE_SECONDS,
  MANDATORY_COMPONENTS,
  MAX_SIGNATURE_WINDOW_SECONDS,
  REQUEST_SIGNING_TAG,
  RESPONSE_MANDATORY_COMPONENTS,
  RESPONSE_SIGNING_TAG,
  type AdcpJsonWebKey,
  type ContentDigestPolicy,
  type RevocationSnapshot,
  type VerifiedSigner,
  type VerifierCapability,
  type VerifyResult,
} from './types';
export { verifyRequestSignature, type VerifyRequestOptions } from './verifier';
export {
  createResponseVerifier,
  verifyResponseSignature,
  type CreateResponseVerifierOptions,
  type VerifyResponseOptions,
  type VerifyResponseResult,
} from './response-verifier';
export {
  createWebhookVerifier,
  verifyWebhookSignature,
  WEBHOOK_MANDATORY_COMPONENTS,
  WEBHOOK_SIGNING_TAG,
  type CreateWebhookVerifierOptions,
  type VerifyWebhookOptions,
  type VerifyWebhookResult,
} from './webhook-verifier';
export { createExpressVerifier, type ExpressLike, type ExpressMiddlewareOptions } from './middleware';
export {
  resolveAgent,
  getAgentJwks,
  createAgentJwksSet,
  AgentResolverError,
  attackerInfluencedFields,
  ATTACKER_INFLUENCED,
  readBrandJsonUrl,
  readIdentityPosture,
  type AgentResolution,
  type AgentProtocol,
  type AgentResolverErrorCode,
  type AgentResolverErrorDetail,
  type AgentEntry,
  type AgentJwksResult,
  type CapabilitiesWithBrandJsonUrl,
  type CreateAgentJwksSetOptions,
  type FetchCapabilitiesFn,
  type GetAgentJwksOptions,
  type IdentityKeyOriginPurpose,
  type IdentityKeyOrigins,
  type IdentityPosture,
  type ResolveAgentOptions,
  type TraceStep,
} from './agent-resolver';
