import { createHash, createPrivateKey, randomUUID, sign as nodeSign, type JsonWebKey } from 'crypto';
import type { SigningProvider } from './provider';
import type { SignerKey } from './signer';
import type { AdcpUse } from './jwks-helpers';
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

export interface EphemeralSigningKey {
  /** The `kid` embedded in both JWKs. */
  kid: string;
  /**
   * AdCP wire-format algorithm identifier — pass directly to
   * `InMemorySigningProvider({ algorithm })`. Always `'ed25519'` today;
   * typed as `AdcpSignAlg` so callers don't hardcode a string literal.
   */
  algorithm: AdcpSignAlg;
  /** Public JWK — publish at `/.well-known/jwks.json` or pass to JWKS discovery. */
  publicKey: AdcpJsonWebKey;
  /**
   * Private JWK with `d` scalar. Pass to
   * `new InMemorySigningProvider({ keyid, algorithm, privateKey })`.
   * Never publish this value.
   */
  privateKey: AdcpJsonWebKey;
}

export interface MintEphemeralSigningKeyOptions {
  /**
   * Stable key ID embedded in both JWKs. Defaults to a random UUID so each
   * call produces a unique kid. Pass a stable value for deterministic IDs
   * across test restarts — the `keyid` passed to `InMemorySigningProvider`
   * must match the `kid` in the published public JWK.
   */
  kid?: string;
  /**
   * AdCP purpose binding tagged on both JWKs.
   * - `'webhook-signing'` (default) — outbound webhook callbacks.
   * - `'request-signing'` — buyer-to-seller signed requests (AdCP step 8).
   *
   * For production request-signing keys use `pemToAdcpJwk()` or a KMS-backed
   * `SigningProvider` instead.
   */
  adcp_use?: AdcpUse;
}

/**
 * Mint an ephemeral Ed25519 keypair as `AdcpJsonWebKey` pairs, ready for
 * dev/test signing.
 *
 * Handles the Node `KeyObject.export({ format: 'jwk' })` → `AdcpJsonWebKey`
 * reshape: Node's `JsonWebKey` has `kty?: string` (optional), while
 * `AdcpJsonWebKey` requires `kty: string`. Without this helper, callers must
 * write a manual spread + non-null assertion on every key-generation site —
 * easy to typo on the most critical JWK field.
 *
 * Both JWKs are tagged with the correct AdCP fields:
 * - `alg: 'EdDSA'` — JOSE algorithm name required by AdCP verifiers (step 8).
 * - `use: 'sig'` — RFC 7517 §4.2 intent hint.
 * - `adcp_use` — AdCP purpose binding; enforced at step 8. Defaults to
 *   `'webhook-signing'`; pass `'request-signing'` for buyer-to-seller keys.
 * - `key_ops`: `['verify']` on `publicKey`, `['sign']` on `privateKey`.
 *
 * Usage with {@link InMemorySigningProvider}:
 * ```ts
 * import { mintEphemeralSigningKey, InMemorySigningProvider } from '@adcp/sdk/signing/testing';
 *
 * const { kid, algorithm, privateKey, publicKey } = await mintEphemeralSigningKey();
 * const provider = new InMemorySigningProvider({ keyid: kid, algorithm, privateKey });
 * // Publish publicKey in your /.well-known/jwks.json `keys` array.
 * ```
 */
export async function mintEphemeralSigningKey(opts?: MintEphemeralSigningKeyOptions): Promise<EphemeralSigningKey> {
  const { generateKeyPair, exportJWK } = await import('jose');
  const resolvedKid = opts?.kid ?? randomUUID();
  const adcpUse: AdcpUse = opts?.adcp_use ?? 'webhook-signing';
  const { publicKey: pubKeyObj, privateKey: privKeyObj } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  const [pubJwk, privJwk] = await Promise.all([exportJWK(pubKeyObj), exportJWK(privKeyObj)]);

  if (!pubJwk.kty) throw new Error('mintEphemeralSigningKey: jose exportJWK returned publicKey without kty');
  if (!privJwk.kty) throw new Error('mintEphemeralSigningKey: jose exportJWK returned privateKey without kty');

  const publicKey: AdcpJsonWebKey = {
    ...(pubJwk as Record<string, unknown>),
    kid: resolvedKid,
    kty: pubJwk.kty,
    alg: 'EdDSA',
    use: 'sig',
    adcp_use: adcpUse,
    key_ops: ['verify'],
  };

  const privateKey: AdcpJsonWebKey = {
    ...(privJwk as Record<string, unknown>),
    kid: resolvedKid,
    kty: privJwk.kty,
    alg: 'EdDSA',
    use: 'sig',
    adcp_use: adcpUse,
    // RFC 7517 §4.3: private JWK states signing intent. Node's createPrivateKey
    // ignores key_ops at runtime; the field is present for JWK consumers that honour it.
    key_ops: ['sign'],
  };

  return { kid: resolvedKid, algorithm: 'ed25519', publicKey, privateKey };
}
