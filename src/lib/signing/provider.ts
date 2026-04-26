import type { AdcpSignAlg } from './types';

/**
 * Pluggable signing backend for RFC 9421 request signatures.
 *
 * Implement this interface to delegate signing to an external key store
 * (KMS, HSM, Vault Transit) without ever loading the private scalar into
 * process memory.
 *
 * Wire-format contract for `sign(payload)`:
 *   - `payload` is the raw UTF-8 bytes of the RFC 9421 signature base.
 *     The SDK builds this string; the provider only handles the final
 *     signing step.
 *   - For `ed25519`: sign `payload` directly — Ed25519 handles
 *     prehashing internally. Return the 64-byte raw signature.
 *   - For `ecdsa-p256-sha256`: compute SHA-256(`payload`) yourself
 *     (or pass `payload` to a KMS API that applies SHA-256 internally),
 *     then return the 64-byte r‖s in IEEE P1363 format (NOT DER).
 *     KMS adapters that return DER-encoded signatures MUST convert to
 *     P1363 before resolving. Do NOT hash twice.
 */
export interface SigningProvider {
  /**
   * Sign the RFC 9421 signature base. See wire-format contract above.
   * KMS latency (10–50 ms) is expected; the SDK awaits this Promise on
   * every signed outbound request.
   */
  sign(payload: Uint8Array): Promise<Uint8Array>;

  /** `kid` published in `Signature-Input`. Must match a key in `jwks_uri`. */
  readonly keyid: string;

  /** Wire-format algorithm — same vocabulary as `ALLOWED_ALGS`. */
  readonly algorithm: AdcpSignAlg;

  /**
   * Stable opaque token that uniquely identifies this private key.
   *
   * Used to isolate transport- and capability-cache entries so two
   * tenants advertising the same `kid` but holding distinct private
   * keys never share a cache entry. Requirements:
   *   - Deterministic across process restarts.
   *   - MUST NOT collide between distinct private keys.
   *   - Must be at least 16 characters to provide adequate cache
   *     isolation entropy (the SDK throws at construction time if
   *     shorter).
   *   - MUST NOT be the raw private key material.
   *
   * Good examples:
   *   - GCP KMS:  `projects/…/cryptoKeyVersions/N` (resource path)
   *   - AWS KMS:  KMS key ARN + "/" + key version
   *   - In-memory: SHA-256(kid + "\0" + d).hex().slice(0, 16)
   *
   * Bad examples (too short or non-unique):
   *   - `"test"`, `kid` alone, `"1"`
   */
  readonly fingerprint: string;
}
