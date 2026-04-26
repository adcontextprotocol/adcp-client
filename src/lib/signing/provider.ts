import type { AdcpSignAlg } from './types';

/**
 * Pluggable signer that the AdCP request- and webhook-signing paths route
 * through when an agent is configured with `request_signing.kind: 'provider'`.
 *
 * Production deployments use this to keep private key material in a managed
 * key store (GCP KMS, AWS KMS, Azure Key Vault, HashiCorp Vault Transit) so
 * the SDK never holds the private scalar in process memory. The `sign(bytes)`
 * boundary matches RFC 9421 §3.1: the caller produces the canonical
 * signature base; the provider returns raw signature bytes.
 *
 * **Adapter authors must:**
 * - Return wire-format signature bytes:
 *   - `ed25519` → 64-byte raw signature.
 *   - `ecdsa-p256-sha256` → 64-byte `r‖s` (IEEE P1363, **not** DER).
 *   GCP KMS returns ECDSA in DER and Ed25519 raw; AWS KMS returns DER for
 *   both EC and Ed25519. Convert at the adapter boundary.
 * - Throw {@link SigningProviderAlgorithmMismatchError} from `sign()` (or, ideally,
 *   from the constructor after a one-shot key inspection) if the underlying
 *   key's algorithm doesn't match the declared `algorithm`. KMS will happily
 *   sign with whatever it has — silent mismatch produces signatures that
 *   verifiers reject downstream with `request_signature_invalid`, which is
 *   useless to the buyer in diagnosing the misconfiguration.
 * - Treat the signer as **single-purpose**. RFC 9421's `tag` parameter
 *   protects verifiers, not signers; reusing the same KMS key for AdCP
 *   request-signing and any other signing protocol creates a cross-protocol
 *   oracle. Bind IAM (e.g., GCP `roles/cloudkms.signer` scoped to one
 *   `cryptoKeyVersions/N`, or AWS `kms:Sign` conditioned on the key ARN) so
 *   only the AdCP signing path can invoke this key.
 *
 * The bundled `InMemorySigningProvider` (under `@adcp/client/signing/testing`)
 * carries a `NODE_ENV=production` gate as a self-discipline aid for the
 * reference implementation only — `createSigningFetchAsync` does NOT and
 * cannot enforce hygiene on third-party providers, so a custom adapter
 * that holds keys in process memory bypasses the gate entirely. Adapter
 * authors are responsible for their own production-safety policy.
 */
export interface SigningProvider {
  /**
   * Sign the RFC 9421 signature base. The SDK passes canonical bytes
   * produced by `buildSignatureBase`; the provider returns raw signature
   * bytes in the wire format described above.
   */
  sign(payload: Uint8Array): Promise<Uint8Array>;

  /**
   * `kid` published in `Signature-Input`. Must match a JWK published at the
   * agent's `jwks_uri`.
   */
  readonly keyid: string;

  /**
   * Wire-format algorithm identifier. Same vocabulary as `ALLOWED_ALGS`.
   */
  readonly algorithm: AdcpSignAlg;

  /**
   * Stable opaque identifier disambiguating this signer from others
   * advertising the same `kid`. Used as input to the SDK's transport- and
   * capability-cache keys.
   *
   * Must be deterministic across process restarts for the same logical key
   * and MUST NOT collide between distinct private keys. Examples:
   * - GCP KMS: `projects/.../cryptoKeyVersions/N`
   * - AWS KMS: KMS key ARN + version
   * - in-memory: `SHA-256(kid + '\\0' + d).slice(0, 16)`
   *
   * The SDK defensively hashes this value before composing cache keys, so a
   * provider returning a low-entropy or attacker-controlled string cannot
   * collapse multi-tenant cache isolation. The hash is a defense-in-depth
   * measure, not a security boundary — adapter authors should still supply
   * a high-entropy stable identifier.
   */
  readonly fingerprint: string;
}
