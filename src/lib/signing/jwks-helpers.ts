import { createPublicKey } from 'node:crypto';
import type { AdcpJsonWebKey, AdcpSignAlg } from './types';

/**
 * Maps AdCP wire-format algorithm identifiers to JOSE `alg` names.
 *
 * These are distinct vocabularies used in different contexts:
 * - AdCP wire identifier (`'ed25519'`, `'ecdsa-p256-sha256'`) appears in
 *   `Signature-Input` and `SigningProvider.algorithm`.
 * - JOSE alg name (`'EdDSA'`, `'ES256'`) appears in published JWKs so JOSE
 *   consumers can locate the right verifier. The AdCP step-8 check asserts this
 *   mapping; using an AdCP wire identifier in place of the JOSE name produces a
 *   `request_signature_key_purpose_invalid` rejection before any crypto runs.
 */
const WIRE_ALG_TO_JOSE: Record<AdcpSignAlg, string> = {
  ed25519: 'EdDSA',
  'ecdsa-p256-sha256': 'ES256',
};

export type AdcpUse = 'request-signing' | 'webhook-signing';

export interface PemToAdcpJwkOptions {
  /** `kid` to embed in the JWK — must match the value published in `Signature-Input`. */
  kid: string;
  /** AdCP wire-format algorithm. Controls which JOSE `alg` name is emitted. */
  algorithm: AdcpSignAlg;
  /**
   * Purpose binding, enforced by AdCP verifiers at step 8.
   * - `'request-signing'` — for JWKs published at the buyer's `jwks_uri`.
   * - `'webhook-signing'` — for JWKs used to sign outbound webhook callbacks.
   */
  adcp_use: AdcpUse;
}

/**
 * Convert a public-key PEM (SPKI / `BEGIN PUBLIC KEY` format) to an AdCP JWK
 * with the correct fields for publication at `/.well-known/jwks.json`.
 *
 * The returned JWK uses the JOSE `alg` name (`"EdDSA"`, `"ES256"`), not the
 * AdCP wire identifier (`"ed25519"`, `"ecdsa-p256-sha256"`). Confusing the two
 * is a common footgun — they appear in different protocol layers and the AdCP
 * step-8 verifier asserts the JOSE name. Using a wire identifier in the JWK
 * causes a `request_signature_key_purpose_invalid` rejection before the
 * signature is verified.
 *
 * Fields set by this helper and why:
 * - `alg`      — JOSE name; required for AdCP step-8 consistency check.
 * - `use`      — `"sig"`; RFC 7517 §4.2 intent hint for JOSE consumers.
 * - `adcp_use` — purpose binding; enforced hard gate at AdCP verifier step 8.
 * - `key_ops`  — `["verify"]`; AdCP verifier checks for `"verify"`, not `"sign"`,
 *               because the published JWK is the public half of the keypair.
 *
 * @throws TypeError when given a private-key PEM or an unparseable PEM.
 *
 * @example
 * ```ts
 * import { pemToAdcpJwk } from '@adcp/client/signing';
 *
 * const jwk = pemToAdcpJwk(fs.readFileSync('keys/addie-2026-04.pem', 'utf8'), {
 *   kid: 'addie-2026-04',
 *   algorithm: 'ed25519',
 *   adcp_use: 'request-signing',
 * });
 * // Serve this object in your /.well-known/jwks.json `keys` array.
 * ```
 */
export function pemToAdcpJwk(pem: string, options: PemToAdcpJwkOptions): AdcpJsonWebKey {
  if (/PRIVATE\s+KEY/.test(pem)) {
    throw new TypeError(
      'pemToAdcpJwk received a private-key PEM. ' +
        'Pass only a public-key PEM (SPKI format: "BEGIN PUBLIC KEY"). ' +
        'Publishing a private key in JWKS is a credential leak.'
    );
  }

  let keyObj;
  try {
    keyObj = createPublicKey({ key: pem, format: 'pem' });
  } catch (err) {
    throw new TypeError(
      `pemToAdcpJwk: failed to parse PEM as a public key — ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Expected SPKI format ("BEGIN PUBLIC KEY").`
    );
  }

  const exported = keyObj.export({ format: 'jwk' }) as Record<string, unknown>;

  return {
    ...exported,
    kid: options.kid,
    alg: WIRE_ALG_TO_JOSE[options.algorithm],
    use: 'sig',
    adcp_use: options.adcp_use,
    key_ops: ['verify'],
  } as AdcpJsonWebKey;
}
