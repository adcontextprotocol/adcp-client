/**
 * GCP KMS-backed `SigningProvider` for AdCP RFC 9421 request and webhook
 * signing. Reference adapter — copy this file into your project and adjust
 * IAM, region, and key-version policy to match your deployment.
 *
 * Usage:
 *
 * ```ts
 * import { createGcpKmsSigningProvider } from './gcp-kms-signing-provider';
 * import type { AgentConfig } from '@adcp/client';
 *
 * const provider = await createGcpKmsSigningProvider({
 *   versionName: process.env.ADCP_KMS_VERSION!,
 *   kid: 'addie-2026-04',
 *   algorithm: 'ecdsa-p256-sha256',
 * });
 *
 * const agent: AgentConfig = {
 *   id: 'addie',
 *   name: 'Addie',
 *   agent_uri: 'https://seller.example.com',
 *   protocol: 'mcp',
 *   request_signing: {
 *     kind: 'provider',
 *     provider,
 *     agent_url: 'https://addie.example.com',
 *   },
 * };
 * ```
 *
 * Hazards:
 * - GCP KMS returns ECDSA signatures DER-encoded; AdCP and RFC 9421 want
 *   raw `r‖s` (IEEE P1363). The adapter converts at the boundary.
 * - GCP KMS Ed25519 (`EC_SIGN_ED25519`) is GA but availability varies by
 *   region/tier. Verify in your target region before pinning.
 * - The `versionName` pins a specific `cryptoKeyVersion`. Rotation is a
 *   redeploy. For lazy primary lookup, see the `lazyPrimary` example below.
 *
 * IAM (least privilege):
 * - GCP: `roles/cloudkms.signer` scoped to the specific `cryptoKeyVersions/N`
 *   resource. Do **not** grant `roles/cloudkms.signerVerifier` — verification
 *   uses only the public key from `jwks_uri`.
 * - Treat the KMS key as single-purpose: the AdCP signing path is the only
 *   caller. Reusing the same key across protocols creates a cross-protocol
 *   oracle.
 */

import { createHash } from 'node:crypto';
import type { SigningProvider } from '@adcp/client/signing';
import { derEcdsaToP1363, SigningProviderAlgorithmMismatchError } from '@adcp/client/signing';

/**
 * Minimal subset of `KeyManagementServiceClient` the adapter calls. Defined
 * structurally so callers can stub it in tests without depending on
 * `@google-cloud/kms`. The real client comes from
 * `import { KeyManagementServiceClient } from '@google-cloud/kms'`.
 */
export interface GcpKmsClientLike {
  asymmetricSign(request: {
    name: string;
    digest?: { sha256?: Buffer | Uint8Array };
    data?: Buffer | Uint8Array;
  }): Promise<[{ signature?: Buffer | Uint8Array | string | null }, ...unknown[]]>;
  getPublicKey(request: { name: string }): Promise<[{ algorithm?: string | null; pem?: string | null }, ...unknown[]]>;
}

export interface GcpKmsSigningProviderOptions {
  /** Full version resource name: `projects/.../cryptoKeyVersions/N`. */
  versionName: string;
  /** Short stable `kid` published in `Signature-Input`. Must match a key in the agent's `jwks_uri`. */
  kid: string;
  /** Wire-format algorithm. Verified against the KMS key on construction. */
  algorithm: 'ed25519' | 'ecdsa-p256-sha256';
  /**
   * GCP KMS client. In production: `new KeyManagementServiceClient()`.
   * Stubbable for tests via the {@link GcpKmsClientLike} structural type.
   */
  client: GcpKmsClientLike;
}

/**
 * Construct a GCP KMS-backed `SigningProvider`. Calls `getPublicKey` once at
 * construction to validate the declared algorithm matches the underlying
 * key — fails fast with {@link SigningProviderAlgorithmMismatchError} rather
 * than producing signatures verifiers would reject downstream.
 */
export async function createGcpKmsSigningProvider(options: GcpKmsSigningProviderOptions): Promise<SigningProvider> {
  const [pubResp] = await options.client.getPublicKey({ name: options.versionName });
  const kmsAlgorithm = pubResp.algorithm ?? '';
  const expectedKmsAlgorithm = mapDeclaredAlgorithmToKms(options.algorithm);
  if (kmsAlgorithm !== expectedKmsAlgorithm) {
    throw new SigningProviderAlgorithmMismatchError(options.algorithm, kmsAlgorithm, options.kid);
  }

  return {
    keyid: options.kid,
    algorithm: options.algorithm,
    fingerprint: options.versionName,
    async sign(payload: Uint8Array): Promise<Uint8Array> {
      if (options.algorithm === 'ecdsa-p256-sha256') {
        const digest = createHash('sha256').update(payload).digest();
        const [resp] = await options.client.asymmetricSign({
          name: options.versionName,
          digest: { sha256: digest },
        });
        const sig = coerceSignature(resp.signature);
        return derEcdsaToP1363(sig, 32);
      }
      const [resp] = await options.client.asymmetricSign({
        name: options.versionName,
        data: payload,
      });
      return coerceSignature(resp.signature);
    },
  };
}

function mapDeclaredAlgorithmToKms(alg: 'ed25519' | 'ecdsa-p256-sha256'): string {
  // GCP KMS algorithm enum names per CryptoKeyVersion.CryptoKeyVersionAlgorithm.
  return alg === 'ed25519' ? 'EC_SIGN_ED25519' : 'EC_SIGN_P256_SHA256';
}

function coerceSignature(value: Buffer | Uint8Array | string | null | undefined): Uint8Array {
  if (value == null) {
    throw new Error('GCP KMS asymmetricSign response did not include a signature.');
  }
  if (typeof value === 'string') {
    return new Uint8Array(Buffer.from(value, 'base64'));
  }
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}
