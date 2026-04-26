/**
 * Test-only signing utilities. Import from `@adcp/client/signing/testing`.
 *
 * @remarks
 * `InMemorySigningProvider` stores the private scalar in process memory —
 * the same security model as `AgentRequestSigningConfig`. It is provided
 * so tests can exercise the `SigningProvider` interface without a real KMS.
 *
 * **Do not use in production.** For KMS-backed signing, implement
 * `SigningProvider` with your KMS client (see
 * `examples/gcp-kms-signing-provider.ts`).
 */
import { createHash, createPrivateKey, sign as nodeSign, type JsonWebKey } from 'node:crypto';
import type { SigningProvider } from './provider';
import type { SignerKey } from './signer';
import type { AdcpSignAlg } from './types';

export type { SigningProvider };

/**
 * In-memory `SigningProvider` backed by a raw private JWK. Delegates to
 * the same Node.js crypto path as `signRequest`, so RFC 9421 test vectors
 * produce byte-identical signatures on both the sync and provider paths.
 *
 * Fingerprint is derived deterministically from `kid + '\0' + d`, matching
 * the legacy `AgentRequestSigningConfig` cache-key derivation — two
 * instances constructed from the same JWK get the same fingerprint and
 * share a cache entry.
 *
 * @example
 * ```ts
 * import { InMemorySigningProvider } from '@adcp/client/signing/testing';
 *
 * const provider = new InMemorySigningProvider({
 *   keyid: 'test-key-1',
 *   algorithm: 'ed25519',
 *   privateKey: JSON.parse(process.env.TEST_PRIV_KEY!),
 * });
 * ```
 */
export class InMemorySigningProvider implements SigningProvider {
  readonly keyid: string;
  readonly algorithm: AdcpSignAlg;
  readonly fingerprint: string;
  private readonly _key: SignerKey;

  constructor(opts: { keyid: string; algorithm: AdcpSignAlg; privateKey: SignerKey['privateKey'] }) {
    this.keyid = opts.keyid;
    this.algorithm = opts.algorithm;
    this._key = { keyid: opts.keyid, alg: opts.algorithm, privateKey: opts.privateKey };
    const d = opts.privateKey.d ?? '';
    this.fingerprint = createHash('sha256').update(opts.keyid).update('\0').update(d).digest('hex').slice(0, 16);
  }

  async sign(payload: Uint8Array): Promise<Uint8Array> {
    const pk = createPrivateKey({ key: this._key.privateKey as JsonWebKey, format: 'jwk' });
    if (this._key.alg === 'ed25519') {
      return new Uint8Array(nodeSign(null, payload, pk));
    }
    return new Uint8Array(nodeSign('sha256', payload, { key: pk, dsaEncoding: 'ieee-p1363' }));
  }
}
