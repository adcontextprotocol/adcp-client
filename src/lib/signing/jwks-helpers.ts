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

/**
 * AdCP JWK purpose discriminator.
 *
 * `'webhook-signing'` is **deprecated** (removed in AdCP 4.0): webhooks are
 * signed with a `'request-signing'` key, differentiated from request
 * signatures by the RFC 9421 `tag`. Verifiers still accept `'webhook-signing'`
 * on the webhook path for backward compatibility, but new signers SHOULD
 * publish and sign with `'request-signing'` keys only (use a second
 * `'request-signing'` key under a distinct `kid` when webhook key isolation
 * is desired).
 */
export type AdcpUse = 'request-signing' | 'webhook-signing' | 'response-signing' | 'governance-signing';

const ADCP_USE_VALUES = new Set<AdcpUse>([
  'request-signing',
  'webhook-signing',
  'response-signing',
  'governance-signing',
]);

export function assertAdcpUse(value: unknown, helperName: string): asserts value is AdcpUse {
  if (typeof value !== 'string' || !ADCP_USE_VALUES.has(value as AdcpUse)) {
    throw new TypeError(
      `${helperName}: unsupported adcp_use '${String(value)}'. ` +
        `Supported: ${Array.from(ADCP_USE_VALUES).join(', ')}.`
    );
  }
}

export interface PemToAdcpJwkOptions {
  /** `kid` to embed in the JWK — must match the value published in `Signature-Input`. */
  kid: string;
  /** AdCP wire-format algorithm. Controls which JOSE `alg` name is emitted. */
  algorithm: AdcpSignAlg;
  /**
   * Purpose binding, enforced by AdCP verifiers at step 8.
   * - `'request-signing'` — for JWKs published at the buyer's `jwks_uri`. Also
   *   signs outbound webhook callbacks (differentiated by the RFC 9421 `tag`).
   * - `'webhook-signing'` — **deprecated** (removed in 4.0); use
   *   `'request-signing'` for webhooks. Still accepted by verifiers for
   *   backward compatibility.
   * - `'response-signing'` — for compatibility with agents that sign JSON
   *   transport responses directly.
   * - `'governance-signing'` — for JWKs used to sign governance context
   *   (JWS-signed, not RFC 9421). Declared on JWKs published in a tenant's
   *   aggregated JWKS so JSON-typed consumers (e.g., third-party verifiers
   *   filtering by `adcp_use`) can identify governance-signing material;
   *   this SDK does not yet ship a `signGovernanceContext` helper — the
   *   verifier surface for governance JWS is deferred work tracked under
   *   adcp-client#1844.
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
 * import { pemToAdcpJwk } from '@adcp/sdk/signing';
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
  assertAdcpUse(options.adcp_use, 'pemToAdcpJwk');

  // Anchored to the BEGIN line so a public-key PEM that mentions "PRIVATE
  // KEY" in surrounding metadata or comments doesn't false-positive. RFC
  // 7468 mandates exact uppercase between dashes; matching all standard
  // private-key headers (`PRIVATE KEY` PKCS#8, `RSA/EC/OPENSSH/ENCRYPTED
  // PRIVATE KEY`).
  if (/-----BEGIN [^-]*PRIVATE KEY-----/.test(pem)) {
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

  const joseAlg = WIRE_ALG_TO_JOSE[options.algorithm];
  if (!joseAlg) {
    throw new TypeError(
      `pemToAdcpJwk: unsupported algorithm '${options.algorithm}'. ` +
        `Supported: ${Object.keys(WIRE_ALG_TO_JOSE).join(', ')}.`
    );
  }

  const exported = keyObj.export({ format: 'jwk' }) as Record<string, unknown>;

  return {
    ...exported,
    kid: options.kid,
    alg: joseAlg,
    use: 'sig',
    adcp_use: options.adcp_use,
    key_ops: ['verify'],
  } as AdcpJsonWebKey;
}
