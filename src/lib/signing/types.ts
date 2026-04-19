export type ContentDigestPolicy = 'required' | 'forbidden' | 'either';

export interface VerifierCapability {
  supported: boolean;
  covers_content_digest: ContentDigestPolicy;
  required_for: string[];
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
  x?: string;
  y?: string;
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
export const ALLOWED_ALGS = new Set(['ed25519', 'ecdsa-p256-sha256']);
export const MAX_SIGNATURE_WINDOW_SECONDS = 300;
export const CLOCK_SKEW_TOLERANCE_SECONDS = 60;
export const MANDATORY_COMPONENTS: ReadonlyArray<string> = ['@method', '@target-uri', '@authority'];
