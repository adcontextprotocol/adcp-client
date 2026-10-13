import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import type { AdcpJsonWebKey, AdcpSignAlg } from '../types';
import { WebBotAuthError } from './errors';

const THUMBPRINT_MEMBERS: Record<string, readonly string[]> = {
  OKP: ['crv', 'kty', 'x'],
  EC: ['crv', 'kty', 'x', 'y'],
  RSA: ['e', 'kty', 'n'],
};

/**
 * RFC 7638 JWK thumbprint (SHA-256, Base64URL), the WBA `kid` of a key.
 * For Ed25519 this is the RFC 8037 Appendix A.3 form. Throws on a key missing
 * a required member.
 */
export function jwkThumbprint(jwk: Readonly<Record<string, unknown>>): string {
  const kty = jwk.kty;
  const members = typeof kty === 'string' ? THUMBPRINT_MEMBERS[kty] : undefined;
  if (!members) throw new TypeError('JWK thumbprint requires an OKP, EC, or RSA key');
  const canonical: Record<string, string> = {};
  for (const name of members) {
    const value = jwk[name];
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`JWK thumbprint requires a non-empty "${name}" member`);
    }
    canonical[name] = value;
  }
  // Members are already in lexicographic order; JSON.stringify keeps that.
  return createHash('sha256').update(JSON.stringify(canonical)).digest('base64url');
}

/** Thumbprint or `undefined` for malformed key material. */
export function tryJwkThumbprint(jwk: unknown): string | undefined {
  if (!jwk || typeof jwk !== 'object') return undefined;
  try {
    return jwkThumbprint(jwk as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

/**
 * Algorithm a WBA verifier derives from a directory key (profile rule:
 * "The verifier derives the algorithm from the key"). Rejects private
 * material, a non-signing `use`, a mismatched `alg`, and `key_ops` that do
 * not allow verification.
 */
export function directoryKeyAlgorithm(jwk: Readonly<Record<string, unknown>>): AdcpSignAlg {
  let alg: AdcpSignAlg | undefined;
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') alg = 'ed25519';
  else if (jwk.kty === 'EC' && jwk.crv === 'P-256') alg = 'ecdsa-p256-sha256';
  if (alg === undefined || 'd' in jwk || '_private_d_for_test_only' in jwk || (jwk.use ?? 'sig') !== 'sig') {
    throw new WebBotAuthError('unsupported directory key');
  }
  // `Ed25519` is the fully specified JOSE name (RFC 9864) for `EdDSA` here.
  const joseNames = alg === 'ed25519' ? ['EdDSA', 'Ed25519'] : ['ES256'];
  if (jwk.alg !== undefined && !joseNames.includes(jwk.alg as string)) {
    throw new WebBotAuthError('directory key algorithm mismatch');
  }
  if (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes('verify'))) {
    throw new WebBotAuthError('directory key cannot verify');
  }
  return alg;
}

/**
 * Public JWK for a key directory: thumbprint `kid`, `use: "sig"`, and no
 * AdCP-specific members (spec R1: purpose separation is by origin).
 */
export function publicDirectoryKey(key: AdcpJsonWebKey | KeyObject): AdcpJsonWebKey {
  const exported = toPublicJwk(key);
  let jwk: AdcpJsonWebKey;
  if (exported.kty === 'OKP' && exported.crv === 'Ed25519' && typeof exported.x === 'string') {
    jwk = { kty: 'OKP', crv: 'Ed25519', x: exported.x, kid: '' };
  } else if (
    exported.kty === 'EC' &&
    exported.crv === 'P-256' &&
    typeof exported.x === 'string' &&
    typeof exported.y === 'string'
  ) {
    jwk = { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y, kid: '' };
  } else {
    throw new TypeError('Web Bot Auth supports Ed25519 and P-256 keys');
  }
  jwk.kid = jwkThumbprint(jwk);
  jwk.use = 'sig';
  return jwk;
}

/** Wire algorithm for a private or public key. */
export function keyAlgorithm(key: AdcpJsonWebKey | KeyObject): AdcpSignAlg {
  return directoryKeyAlgorithm(publicDirectoryKey(key) as Record<string, unknown>);
}

/** Load a private JWK, PEM string, or KeyObject as a private `KeyObject`. */
export function toPrivateKeyObject(key: AdcpJsonWebKey | KeyObject | string): KeyObject {
  if (typeof key === 'string') return createPrivateKey(key);
  if (isKeyObject(key)) {
    if (key.type !== 'private') throw new TypeError('A private key is required for signing');
    return key;
  }
  const jwk = { ...(key as Record<string, unknown>) };
  if (jwk.d === undefined && typeof jwk._private_d_for_test_only === 'string') jwk.d = jwk._private_d_for_test_only;
  if (typeof jwk.d !== 'string') throw new TypeError('A private JWK with "d" is required for signing');
  // JWK input; the cast avoids naming node's JsonWebKey in published declarations.
  return createPrivateKey({ key: stripNonJose(jwk) as never, format: 'jwk' });
}

function toPublicJwk(key: AdcpJsonWebKey | KeyObject): Record<string, unknown> {
  if (isKeyObject(key)) {
    return createPublicKey(key).export({ format: 'jwk' }) as Record<string, unknown>;
  }
  const jwk = key as Record<string, unknown>;
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

function stripNonJose(jwk: Record<string, unknown>): Record<string, unknown> {
  const { kty, crv, x, y, d } = jwk;
  return Object.fromEntries(Object.entries({ kty, crv, x, y, d }).filter(([, v]) => v !== undefined));
}

function isKeyObject(value: unknown): value is KeyObject {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as KeyObject).export === 'function' &&
    typeof (value as KeyObject).type === 'string'
  );
}
