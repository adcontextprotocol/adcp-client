/**
 * Shared networking primitives for the client library. Home of the SSRF-safe
 * fetch used by compliance probes, the storyboard runner, and counterparty
 * metadata resolvers (JWKS, revocation lists).
 */
export {
  ssrfSafeFetch,
  decodeBodyAsJsonOrText,
  SsrfRefusedError,
  type SsrfRefusedCode,
  type SsrfFetchOptions,
  type SsrfFetchResult,
} from './ssrf-fetch';
export { isPrivateIp, isAlwaysBlocked } from './address-guards';
