/**
 * GCP KMS-backed `SigningProvider` for AdCP RFC 9421 request and webhook
 * signing. Reference adapter — copy this file into your project and adjust
 * IAM, region, and key-version policy to match your deployment.
 *
 * Usage:
 *
 * ```ts
 * // Consumer-side wiring. The KMS client construction is the consumer's
 * // responsibility — the SDK keeps `@google-cloud/kms` out of its deps so
 * // non-GCP users don't pay the install cost.
 * import { KeyManagementServiceClient } from '@google-cloud/kms';
 * import { createGcpKmsSigningProvider } from './gcp-kms-signing-provider';
 * import type { AgentConfig } from '@adcp/client';
 *
 * const kmsClient = new KeyManagementServiceClient(); // ADC inside GCP, or
 *                                                     // explicit credentials elsewhere
 *
 * const provider = await createGcpKmsSigningProvider({
 *   versionName: process.env.ADCP_KMS_VERSION!,
 *   kid: 'addie-2026-04',
 *   algorithm: 'ecdsa-p256-sha256',
 *   client: kmsClient,
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
 *   redeploy. See `createGcpKmsSigningProviderLazy` below for a variant that
 *   defers initialization until the first signed request.
 *
 * IAM (least privilege):
 * - GCP: `roles/cloudkms.signer` scoped to the specific `cryptoKeyVersions/N`
 *   resource. Do **not** grant `roles/cloudkms.signerVerifier` — verification
 *   uses only the public key from `jwks_uri`.
 * - Treat the KMS key as single-purpose: the AdCP signing path is the only
 *   caller. Reusing the same key across protocols creates a cross-protocol
 *   oracle.
 *
 * Request-signing vs webhook-signing keys: AdCP **requires distinct key
 * material** per purpose (see `docs/guides/SIGNING-GUIDE.md` § Key
 * separation). The verifier's `adcp_use` discriminator and RFC 9421's `tag`
 * parameter are gating checks that reject wrong-purpose presentation; they
 * are not a license to share the underlying scalar across profiles. Mint a
 * second `cryptoKeyVersion` for webhook signing — KMS makes this cheap.
 */

import { createHash, createPublicKey } from 'node:crypto';
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
  /**
   * Optional tripwire: a PEM-encoded public key committed to your source repo.
   * When provided, the constructor compares the SPKI bytes returned by KMS
   * against this value and throws if they differ.
   *
   * This catches silent out-of-band key rotations (disabled key version, IAM
   * swap, hostile substitution) before the first signed request. Without it,
   * a rotated KMS key starts producing signatures that verifiers reject with
   * `request_signature_key_unknown` — no clear signal that the JWKS is stale.
   *
   * Pattern:
   * ```
   * # Export the expected public key once and commit it:
   * gcloud kms keys versions get-public-key 1 \
   *   --location=us-east1 --keyring=adcp --key=adcp-signing \
   *   --output-file=keys/addie-2026-04.pem
   * git add keys/addie-2026-04.pem && git commit -m "chore: commit signer public key for tripwire"
   * ```
   *
   * Then pass `expectedPublicKeyPem: fs.readFileSync('keys/addie-2026-04.pem', 'utf8')`.
   */
  expectedPublicKeyPem?: string;
}

/**
 * Construct a GCP KMS-backed `SigningProvider`. Calls `getPublicKey` once at
 * construction to validate the declared algorithm matches the underlying
 * key — fails fast with {@link SigningProviderAlgorithmMismatchError} rather
 * than producing signatures verifiers would reject downstream.
 *
 * If `expectedPublicKeyPem` is provided, also asserts the SPKI bytes returned
 * by KMS match the committed PEM (tripwire against silent key rotation).
 *
 * For a variant that defers initialization to the first `sign()` call, see
 * {@link createGcpKmsSigningProviderLazy}.
 */
export async function createGcpKmsSigningProvider(options: GcpKmsSigningProviderOptions): Promise<SigningProvider> {
  const [pubResp] = await options.client.getPublicKey({ name: options.versionName });
  const kmsAlgorithm = pubResp.algorithm ?? '';
  const expectedKmsAlgorithm = mapDeclaredAlgorithmToKms(options.algorithm);
  if (kmsAlgorithm !== expectedKmsAlgorithm) {
    throw new SigningProviderAlgorithmMismatchError(options.algorithm, kmsAlgorithm, options.kid);
  }

  if (options.expectedPublicKeyPem != null) {
    if (pubResp.pem == null) {
      throw new Error(
        `KMS returned no public key material for ${options.versionName}; cannot verify expectedPublicKeyPem tripwire.`
      );
    }
    assertSpkiMatches(options.versionName, pubResp.pem, options.expectedPublicKeyPem);
  }

  return {
    keyid: options.kid,
    algorithm: options.algorithm,
    fingerprint: options.versionName,
    async sign(payload: Uint8Array): Promise<Uint8Array> {
      return kmsSign(options, payload);
    },
  };
}

/**
 * Lazy-initialization variant of {@link createGcpKmsSigningProvider}.
 *
 * Unlike the eager factory, this constructor returns synchronously without
 * touching KMS. The first `sign()` call triggers `getPublicKey` (algorithm
 * validation + optional tripwire check). Subsequent calls skip initialization.
 *
 * Choose between eager and lazy based on your operational priorities:
 *
 * | | Eager (`createGcpKmsSigningProvider`) | Lazy (this) |
 * |---|---|---|
 * | Boot fails if KMS unreachable | yes | no |
 * | Misconfiguration surface | deploy time | first request |
 * | Cold-start latency on first sign | none (already done) | one `getPublicKey` RTT |
 *
 * **Thundering-herd / concurrent-first-call safety:** the lazy pattern below
 * uses an in-flight promise that is deduplicated across concurrent callers.
 * Critically, the promise is **cleared on rejection** so a transient KMS blip
 * during the first call retries rather than permanently caching the failure:
 *
 * ```
 * inflightInit = init().catch(err => { inflightInit = null; throw err; });
 * ```
 *
 * Without the `catch` clear, a transient network error during init permanently
 * bricks the provider for the lifetime of the process — every subsequent
 * `sign()` call receives the same rejected promise.
 */
export function createGcpKmsSigningProviderLazy(options: GcpKmsSigningProviderOptions): SigningProvider {
  let initialized = false;
  let inflightInit: Promise<void> | null = null;

  async function ensureInitialized(): Promise<void> {
    if (initialized) return;
    if (!inflightInit) {
      inflightInit = initProvider().then(
        () => {
          initialized = true;
          inflightInit = null;
        },
        err => {
          inflightInit = null; // Clear so the next call retries
          throw err;
        }
      );
    }
    return inflightInit;
  }

  async function initProvider(): Promise<void> {
    const [pubResp] = await options.client.getPublicKey({ name: options.versionName });
    const kmsAlgorithm = pubResp.algorithm ?? '';
    const expectedKmsAlgorithm = mapDeclaredAlgorithmToKms(options.algorithm);
    if (kmsAlgorithm !== expectedKmsAlgorithm) {
      throw new SigningProviderAlgorithmMismatchError(options.algorithm, kmsAlgorithm, options.kid);
    }
    if (options.expectedPublicKeyPem != null) {
      if (pubResp.pem == null) {
        throw new Error(
          `KMS returned no public key material for ${options.versionName}; cannot verify expectedPublicKeyPem tripwire.`
        );
      }
      assertSpkiMatches(options.versionName, pubResp.pem, options.expectedPublicKeyPem);
    }
  }

  return {
    keyid: options.kid,
    algorithm: options.algorithm,
    fingerprint: options.versionName,
    async sign(payload: Uint8Array): Promise<Uint8Array> {
      await ensureInitialized();
      return kmsSign(options, payload);
    },
  };
}

// --- Shared helpers ---

function mapDeclaredAlgorithmToKms(alg: 'ed25519' | 'ecdsa-p256-sha256'): string {
  // GCP KMS algorithm enum names per CryptoKeyVersion.CryptoKeyVersionAlgorithm.
  return alg === 'ed25519' ? 'EC_SIGN_ED25519' : 'EC_SIGN_P256_SHA256';
}

async function kmsSign(options: GcpKmsSigningProviderOptions, payload: Uint8Array): Promise<Uint8Array> {
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
}

function assertSpkiMatches(versionName: string, actualPem: string, expectedPem: string): void {
  const toSpki = (pem: string) =>
    createPublicKey({ key: pem, format: 'pem' }).export({ type: 'spki', format: 'der' }) as Buffer;
  const actual = toSpki(actualPem);
  const expected = toSpki(expectedPem);
  if (!actual.equals(expected)) {
    throw new Error(
      `KMS key ${versionName} public SPKI does not match the committed expectedPublicKeyPem. ` +
        `An out-of-band key rotation may have occurred. ` +
        `Commit the new public key PEM and redeploy to clear this guard.`
    );
  }
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
