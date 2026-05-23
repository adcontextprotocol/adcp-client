export type ContentDigestPolicy = 'required' | 'forbidden' | 'either';

export interface VerifierCapability {
  supported: boolean;
  covers_content_digest: ContentDigestPolicy;
  required_for: string[];
  /**
   * JSON-RPC protocol method names (for example `tasks/cancel`) that MUST
   * arrive signed. This is intentionally separate from `required_for`, which
   * names AdCP tools carried inside `tools/call.params.name`.
   */
  protocol_methods_required_for?: string[];
  /**
   * Shadow-mode bridge between `supported_for` and `required_for`: the seller
   * verifies signatures when present and logs failures but does NOT reject
   * unsigned requests. Counterparties SHOULD sign ops in this list so sellers
   * can surface failure rates before flipping to `required_for`. Precedence:
   * `required_for` > `warn_for` > `supported_for`.
   */
  warn_for?: string[];
  supported_for?: string[];
}

export interface AdcpJsonWebKey {
  kid: string;
  kty: string;
  crv?: string;
  alg?: string;
  use?: string;
  key_ops?: string[];
  adcp_use?: string;
  /** Public-key X coordinate (Ed25519) or x-coordinate (EC P-256). */
  x?: string;
  /** Public-key Y coordinate (EC P-256 only). */
  y?: string;
  /**
   * Private scalar (RFC 7518 §6.2.2.1 / §6.1.2). Present only when the JWK
   * represents a private key — never published at `jwks_uri`. Test vectors
   * ship this under `_private_d_for_test_only` in their `keys.json`; runtime
   * signers load it into `d`.
   */
  d?: string;
  [extra: string]: unknown;
}

export interface RevocationSnapshot {
  issuer: string;
  updated: string;
  next_update: string;
  revoked_kids: string[];
  revoked_jtis: string[];
}

/**
 * Narrow "successfully verified" shape. Middleware sets `req.verifiedSigner`
 * to a value of this type only after a real signature was validated — the
 * absence of `req.verifiedSigner` is the signal that the request went through
 * the verifier as unsigned (and the operation didn't require signing).
 *
 * `keyid` is always non-empty. Pre-3.x releases returned a `keyid: ''`
 * sentinel on the unsigned path; consumers MUST now branch on
 * `req.verifiedSigner === undefined` instead.
 */
export interface VerifiedSigner {
  keyid: string;
  agent_url?: string;
  verified_at: number;
}

/**
 * Discriminated union returned by `verifyRequestSignature`.
 *
 * - `{ status: 'verified', ... }` — a signature was present and passed all
 *   pipeline steps. Shape extends {@link VerifiedSigner}.
 * - `{ status: 'unsigned' }` — no signature headers were present, and the
 *   operation was not in `capability.required_for` (or no operation was
 *   supplied). The request may still be accepted by the server's own auth
 *   path; the verifier just has no signer to attest to.
 *
 * A caller that needs to distinguish "unsigned but acceptable" from
 * "verified" should branch on `.status`. Most middleware consumers should
 * instead rely on `req.verifiedSigner` being populated — that reads cleanly
 * as "did a real signature check succeed."
 */
export type VerifyResult = ({ status: 'verified' } & VerifiedSigner) | { status: 'unsigned'; verified_at: number };

export const REQUEST_SIGNING_TAG = 'adcp/request-signing/v1';
/**
 * Tag value for the AdCP response-signing profile (RFC 9421 §2.2.9).
 *
 * Signer ships in #1823; verifier (`verifyResponseSignature`) ships in
 * #1826. The wire format is now exercised both directions inside this SDK
 * via round-trip tests. The `v1` suffix gives a clean break path if cross-
 * SDK interop testing later surfaces an incompat — any breaking change
 * ships as `v2` and verifiers reject `v1`.
 */
export const RESPONSE_SIGNING_TAG = 'adcp/response-signing/v1';
export const ALLOWED_ALGS = new Set(['ed25519', 'ecdsa-p256-sha256']);
/**
 * Wire-format algorithm identifier — the string that appears in
 * `Signature-Input`'s `alg` parameter. Same vocabulary as `ALLOWED_ALGS`.
 */
export type AdcpSignAlg = 'ed25519' | 'ecdsa-p256-sha256';
export const MAX_SIGNATURE_WINDOW_SECONDS = 300;
export const CLOCK_SKEW_TOLERANCE_SECONDS = 60;
export const MANDATORY_COMPONENTS: ReadonlyArray<string> = ['@method', '@target-uri', '@authority'];
/**
 * Minimum derived components covered by a response signature under the AdCP
 * response-signing profile (RFC 9421 §2.2.9).
 *
 * - `@status` — binds the signature to the response status code.
 * - `@authority` — binds it to the request origin the response was emitted
 *   for (so a compromised origin can't cross-sign for a sibling tenant on
 *   the same fleet).
 * - `@target-uri` — binds the signature to the specific request path + query,
 *   preventing a multi-tenant seller from emitting interchangeable signatures
 *   across endpoints sharing the same authority. Matches RFC 9421 §B.2.5
 *   examples for response signing.
 *
 * `content-type` + `content-digest` are added at signing time when the
 * response carries a body — `content-digest` is opt-out via
 * `coverContentDigest: false` because an unbound body is the most common
 * cross-purpose footgun for response signing. Callers can extend the
 * covered set further via `SignResponseOptions.additionalComponents`
 * (e.g. `@method`, custom headers).
 *
 * Signer ships in #1823; verifier (`verifyResponseSignature`) ships in
 * #1826. The wire format is now exercised both directions inside this SDK
 * via round-trip tests. The `v1` tag suffix gives a clean break path if
 * cross-SDK interop testing later surfaces an incompat.
 */
export const RESPONSE_MANDATORY_COMPONENTS: ReadonlyArray<string> = ['@status', '@authority', '@target-uri'];
