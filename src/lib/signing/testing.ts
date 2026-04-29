import { createHash, createPrivateKey, sign as nodeSign, type JsonWebKey } from 'crypto';
import type { SigningProvider } from './provider';
import type { SignerKey } from './signer';
import type { AdcpJsonWebKey, AdcpSignAlg } from './types';

/**
 * Environment variable that lets operators acknowledge an in-memory signer
 * is intentional in a `NODE_ENV=production` deployment (CI runs with
 * production builds, ephemeral test envs, etc.). Set to `1` to bypass the
 * production-time guard.
 */
export const ALLOW_IN_MEMORY_SIGNER_ENV = 'ADCP_ALLOW_IN_MEMORY_SIGNER';

export interface InMemorySigningProviderOptions {
  /** `kid` published in `Signature-Input`. */
  keyid: string;
  /** Wire-format algorithm identifier — must match the JWK material. */
  algorithm: AdcpSignAlg;
  /** Private JWK including the `d` scalar. */
  privateKey: AdcpJsonWebKey;
}

/**
 * Reference {@link SigningProvider} that holds the private JWK in process
 * memory. Useful for unit tests, conformance vectors, and local development.
 *
 * **Production deployments should use a KMS-backed provider** (see
 * `examples/gcp-kms-signing-provider.ts`). To prevent accidental shipping of
 * an in-memory signer to prod, the constructor refuses to instantiate when
 * `NODE_ENV === 'production'` unless the operator sets
 * `ADCP_ALLOW_IN_MEMORY_SIGNER=1` to acknowledge the choice — keeping the
 * in-memory path grep-able in deploy manifests.
 */
export class InMemorySigningProvider implements SigningProvider {
  readonly keyid: string;
  readonly algorithm: AdcpSignAlg;
  readonly fingerprint: string;
  private readonly privateKey: AdcpJsonWebKey;

  constructor(options: InMemorySigningProviderOptions) {
    // The env is read once at construction. Module-init paths that
    // instantiate `InMemorySigningProvider` before the runtime sets
    // `NODE_ENV` will bypass the gate; orchestrators conventionally set
    // `NODE_ENV` before the app process spawns, so this is rare in practice.
    // Compare case-insensitively so `Production` / `PRODUCTION` don't slip
    // through.
    const isProduction = process.env.NODE_ENV?.toLowerCase() === 'production';
    if (isProduction && !process.env[ALLOW_IN_MEMORY_SIGNER_ENV]) {
      throw new Error(
        `InMemorySigningProvider blocked in production. Set ${ALLOW_IN_MEMORY_SIGNER_ENV}=1 to acknowledge, ` +
          `or use a KMS-backed SigningProvider (see examples/gcp-kms-signing-provider.ts).`
      );
    }
    if (!options.privateKey.d) {
      throw new TypeError('InMemorySigningProvider requires a JWK with a `d` (private scalar) field.');
    }
    this.keyid = options.keyid;
    this.algorithm = options.algorithm;
    this.privateKey = options.privateKey;
    // Mirrors the historical `privateKeyFingerprint` derivation — same input,
    // same 64-bit cache disambiguator, so behavior carries over for callers
    // who switch from the inline `request_signing` shape to a provider while
    // holding the same key material.
    this.fingerprint = createHash('sha256')
      .update(options.keyid)
      .update('\0')
      .update(options.privateKey.d as string)
      .digest('hex')
      .slice(0, 16);
  }

  async sign(payload: Uint8Array): Promise<Uint8Array> {
    const privateKey = createPrivateKey({ key: this.privateKey as JsonWebKey, format: 'jwk' });
    const data = Buffer.from(payload);
    if (this.algorithm === 'ed25519') {
      return new Uint8Array(nodeSign(null, data, privateKey));
    }
    return new Uint8Array(nodeSign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' }));
  }
}

/**
 * Adapter from a legacy {@link SignerKey} to a {@link SigningProvider}.
 * Lets callers (and the conformance runner) reuse private JWK material
 * loaded for the sync-signing path against the new async-provider pipeline
 * without rewriting key-load logic.
 */
export function signerKeyToProvider(key: SignerKey): SigningProvider {
  return new InMemorySigningProvider({
    keyid: key.keyid,
    algorithm: key.alg,
    privateKey: key.privateKey,
  });
}
