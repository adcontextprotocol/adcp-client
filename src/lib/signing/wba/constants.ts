/**
 * Wire constants for the experimental AdCP 3.3 Web Bot Auth (WBA) profile.
 *
 * Values follow draft-ietf-webbotauth-httpsig-protocol-00 and the AdCP WBA
 * profile page (adcp#7894, pinned in `test/fixtures/wba-profile-vectors`).
 * The profile adds nothing to the WBA wire: AdCP only chooses its numbers.
 */

/** RFC 9421 `tag` for WBA request and webhook signatures. */
export const WEB_BOT_AUTH_TAG = 'web-bot-auth';
/** RFC 9421 `tag` for signed key-directory responses (WBA Appendix B.1). */
export const KEY_DIRECTORY_TAG = 'http-message-signatures-directory';
/** Well-known path of an origin's HTTP Message Signatures Directory. */
export const KEY_DIRECTORY_PATH = '/.well-known/http-message-signatures-directory';
/** Media type of a key directory response (WBA §5.5.1, §8.2). */
export const KEY_DIRECTORY_MEDIA_TYPE = 'application/http-message-signatures-directory+json';
/** An identity's signed revocation list lives at its own origin (spec R3). */
export const ORIGIN_REVOCATION_PATH = '/.well-known/governance-revocations.json';
/** JWS `typ` of a signed AdCP revocation list. */
export const REVOCATION_LIST_TYP = 'adcp-gov-revocation+jws';

/** `expires - created` ceiling for WBA request signatures. */
export const WBA_MAX_SIGNATURE_LIFETIME_SECONDS = 300;
/** Clock skew a verifier allows on request signatures. */
export const WBA_CLOCK_SKEW_SECONDS = 60;
/** Minimum RFC 9421 nonce length (128 bits as Base64URL is 22 characters). */
export const WBA_MIN_NONCE_LENGTH = 22;
/** Maximum accepted nonce length. */
export const WBA_MAX_NONCE_LENGTH = 256;
/** Upper bound on a Signature, Signature-Input, or Signature-Agent field. */
export const WBA_MAX_SIGNATURE_FIELD_BYTES = 65_536;

/** Key-directory body cap (AdCP fetch budget). */
export const KEY_DIRECTORY_MAX_BYTES = 256 * 1024;
/** Key-count limit for one directory (WBA §6.7). */
export const KEY_DIRECTORY_MAX_KEYS = 100;
/** Positive key-directory cache lifetime ceiling (WBA Appendix C.5). */
export const KEY_DIRECTORY_MAX_CACHE_SECONDS = 300;
/** Negative cache for failed discovery fetches (AdCP: at most 60 s). */
export const DISCOVERY_NEGATIVE_CACHE_SECONDS = 60;
/** Total discovery fetch deadline. */
export const DISCOVERY_FETCH_TIMEOUT_MS = 10_000;

/** RFC 9421 profile identifier advertised in `request_signing.profiles`. */
export const RFC9421_REQUEST_SIGNING_PROFILE = 'adcp/request-signing/v1';

/** Request-signing profiles named in `request_signing.profiles` (adcp#7894). */
export type RequestSigningProfile = typeof RFC9421_REQUEST_SIGNING_PROFILE | typeof WEB_BOT_AUTH_TAG;
