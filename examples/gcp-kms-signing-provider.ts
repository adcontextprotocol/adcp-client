/**
 * GCP Cloud KMS adapter for `SigningProvider`.
 *
 * This file is an example — it is NOT bundled with `@adcp/client`. Users must
 * install `@google-cloud/kms` themselves:
 *
 *   npm install @google-cloud/kms
 *
 * ## Algorithm support
 *
 * | Algorithm          | GCP KMS algorithm name      | Supported |
 * |--------------------|----------------------------|-----------|
 * | ecdsa-p256-sha256  | EC_SIGN_P256_SHA256         | ✅        |
 * | ed25519            | (not available in GCP KMS)  | ❌        |
 *
 * GCP Cloud KMS does not offer Ed25519 asymmetric signing. Use
 * `InMemorySigningProvider` from `@adcp/client/signing/testing` for Ed25519
 * test keys, or use a different KMS provider that supports Ed25519.
 *
 * ## Wire-format note (ECDSA)
 *
 * GCP KMS returns ECDSA signatures in DER format. The AdCP verifier expects
 * IEEE P1363 (64-byte r‖s). This adapter converts DER → P1363 automatically.
 *
 * ## Pre-hash note
 *
 * GCP's `EC_SIGN_P256_SHA256` API requires the caller to supply the pre-computed
 * SHA-256 digest (32 bytes). GCP applies ECDSA to the digest without hashing it
 * again. The result is a valid ECDSA signature over SHA256(signature_base),
 * which is exactly what the AdCP verifier expects (`nodeVerify('sha256', ...)`).
 * Do NOT hash the payload twice — pass `SHA256(payload)` as the digest, not
 * `SHA256(SHA256(payload))`.
 *
 * @example
 * ```ts
 * import { createGcpKmsSigningProvider } from './gcp-kms-signing-provider';
 * import { buildAgentSigningContextFromConfig } from '@adcp/client/signing/client';
 *
 * const provider = createGcpKmsSigningProvider({
 *   versionName: 'projects/my-project/locations/us-east1/keyRings/adcp/cryptoKeys/buyer-signing/cryptoKeyVersions/1',
 *   kid: 'buyer-signing-2026',
 *   algorithm: 'ecdsa-p256-sha256',
 * });
 *
 * const signingContext = buildAgentSigningContextFromConfig(
 *   { provider, agent_url: 'https://buyer.example.com' },
 *   'https://seller.example.com'
 * );
 * ```
 */

import { createHash } from 'node:crypto';
// @ts-expect-error — peer dependency not installed in the SDK itself
import { KeyManagementServiceClient } from '@google-cloud/kms';
import type { SigningProvider } from '@adcp/client/signing/client';

export interface GcpKmsSigningProviderOptions {
  /**
   * Full CryptoKeyVersion resource name:
   * `projects/PROJECT/locations/LOCATION/keyRings/RING/cryptoKeys/KEY/cryptoKeyVersions/VERSION`
   *
   * This is used as the `fingerprint` — it is stable, deterministic, and
   * unique per key version, satisfying the `SigningProvider.fingerprint` contract.
   * Do NOT use the key name (without version) — two key versions share a key name
   * but have different private keys and must not collide in the capability cache.
   */
  versionName: string;
  /**
   * Short, stable `kid` published in your JWKS. Must match the key at
   * `{agent_url}/.well-known/adcp-jwks.json`. Do NOT use the full
   * `versionName` as the `kid` — `kid` is a public identifier and the
   * resource path leaks internal GCP project structure.
   */
  kid: string;
  /** Only `ecdsa-p256-sha256` is supported by GCP KMS. */
  algorithm: 'ecdsa-p256-sha256';
  /** Optionally inject a pre-constructed client (useful in tests). */
  client?: InstanceType<typeof KeyManagementServiceClient>;
}

export function createGcpKmsSigningProvider(opts: GcpKmsSigningProviderOptions): SigningProvider {
  if (opts.algorithm !== 'ecdsa-p256-sha256') {
    // GCP KMS does not offer Ed25519. Fail at construction rather than at
    // first sign() call so the misconfiguration surfaces immediately.
    throw new Error(
      `GCP KMS does not support algorithm "${opts.algorithm}". ` +
        'Only "ecdsa-p256-sha256" is available. ' +
        'For Ed25519 test keys use InMemorySigningProvider from @adcp/client/signing/testing.'
    );
  }

  const client: InstanceType<typeof KeyManagementServiceClient> =
    opts.client ?? new KeyManagementServiceClient();

  return {
    keyid: opts.kid,
    algorithm: opts.algorithm,
    // versionName is a stable, unique identifier for this key version —
    // satisfies the fingerprint uniqueness and determinism requirements.
    fingerprint: opts.versionName,

    async sign(payload: Uint8Array): Promise<Uint8Array> {
      // Compute SHA-256 of the RFC 9421 signature base. GCP's
      // EC_SIGN_P256_SHA256 expects the pre-computed digest (32 bytes);
      // GCP applies ECDSA directly to those bytes without hashing again.
      // Result: signature over SHA256(payload), matching nodeVerify('sha256').
      const digest = createHash('sha256').update(payload).digest();

      const [resp] = await client.asymmetricSign({
        name: opts.versionName,
        digest: { sha256: digest },
      });

      const derBytes = resp.signature instanceof Buffer ? resp.signature : Buffer.from(resp.signature);
      return derEcdsaToP1363(derBytes, 32);
    },
  };
}

/**
 * Convert a DER-encoded ECDSA signature to IEEE P1363 (r‖s).
 *
 * DER layout for ECDSA: 0x30 [total-len] 0x02 [r-len] [r-bytes] 0x02 [s-len] [s-bytes]
 * P1363 layout: fixed-width r‖s, each component zero-padded to `coordBytes`.
 */
function derEcdsaToP1363(der: Buffer, coordBytes: number): Uint8Array {
  let offset = 0;
  if (der[offset++] !== 0x30) throw new Error('GCP KMS: expected DER SEQUENCE tag 0x30');
  // Skip length (may be 1 or 2 bytes).
  if (der[offset] & 0x80) offset += (der[offset] & 0x7f) + 1;
  else offset++;

  function readInt(): Buffer {
    if (der[offset++] !== 0x02) throw new Error('GCP KMS: expected DER INTEGER tag 0x02');
    const len = der[offset++];
    const value = der.subarray(offset, offset + len);
    offset += len;
    return Buffer.from(value);
  }

  const r = readInt();
  const s = readInt();

  const out = Buffer.alloc(coordBytes * 2);
  // Strip leading zero byte that DER adds to keep the sign bit clear.
  const rStripped = r[0] === 0x00 ? r.subarray(1) : r;
  const sStripped = s[0] === 0x00 ? s.subarray(1) : s;
  rStripped.copy(out, coordBytes - rStripped.length);
  sStripped.copy(out, coordBytes * 2 - sStripped.length);
  return new Uint8Array(out);
}
