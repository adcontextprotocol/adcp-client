/**
 * Experimental AdCP 3.3 Web Bot Auth profile (draft-ietf-webbotauth-httpsig-protocol-00
 * as profiled by adcp#7894). Opt-in; the wire pin stays AdCP 3.2.
 */
export * from './constants';
export { WebBotAuthError, WebBotAuthAuthorizationError, acceptSignatureHeader, type WebBotAuthStatus } from './errors';
export { jwkThumbprint, publicDirectoryKey, directoryKeyAlgorithm } from './keys';
export { webBotAuthOrigin, WebBotAuthOriginError } from './origin';
export {
  prepareWebBotAuthRequestSignature,
  finalizeWebBotAuthRequestSignature,
  signWebBotAuthRequest,
  signWebBotAuthRequestAsync,
  signKeyDirectory,
  keyDirectoryNeedsRenewal,
  keyDirectoryExpiry,
  type KeyDirectoryResponse,
  type PreparedWebBotAuthSignature,
  type SignedKeyDirectory,
  type SignedWebBotAuthRequest,
  type SignKeyDirectoryOptions,
  type SignWebBotAuthRequestOptions,
  type WebBotAuthSignerKey,
} from './sign';
export {
  verifyKeyDirectoryResponse,
  fetchKeyDirectory,
  WebBotAuthKeyDirectoryResolver,
  StaticWebBotAuthKeys,
  type FetchKeyDirectoryOptions,
  type KeyDirectoryFetcher,
  type WebBotAuthKeyDirectoryResolverOptions,
} from './directory';
export {
  verifyWebBotAuthRequest,
  usesWebBotAuth,
  WBA_REPLAY_SCOPE,
  type VerifiedWebBotAuthSigner,
  type VerifyWebBotAuthRequestOptions,
  type WebBotAuthRequestLike,
  type WebBotAuthRevocationCheck,
} from './verifier';
export {
  OriginRevocationChecker,
  RevocationHistory,
  REVOCATION_REASONS,
  fetchRevocationList,
  mergeRevocationDetails,
  parseRevocationDetails,
  parseRevocationListPayload,
  revocationExposes,
  verifyRevocationJws,
  type OriginRevocationCheckerOptions,
  type RevocationDetails,
  type RevocationListFetcher,
  type RevocationListPayload,
  type RevocationListResponse,
  type RevocationReason,
} from './revocation';
export type { EstablishedWebBotAuthIdentity, WebBotAuthVerifierConfig } from './authorize';
