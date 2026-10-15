import {
  constants,
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
  verify as nodeVerify,
  type JsonWebKey,
  type KeyObject,
} from 'crypto';
import { RequestSignatureError } from './errors';
import type { AdcpJsonWebKey } from './types';

export function jwkToPublicKey(jwk: AdcpJsonWebKey): KeyObject {
  const publicJwk: Record<string, unknown> = { ...jwk };
  delete publicJwk._private_d_for_test_only;
  delete publicJwk.d;
  try {
    return createPublicKey({ key: publicJwk as JsonWebKey, format: 'jwk' });
  } catch (err) {
    throw new RequestSignatureError(
      'request_signature_key_unknown',
      7,
      `JWK for keyid "${(jwk.kid as string) ?? '<unknown>'}" is malformed`,
      err
    );
  }
}

export function verifySignature(alg: string, publicKey: KeyObject, data: Uint8Array, signature: Uint8Array): boolean {
  try {
    if (alg === 'ed25519') {
      return nodeVerify(null, data, publicKey, signature);
    }
    if (alg === 'ecdsa-p256-sha256') {
      try {
        return nodeVerify('sha256', data, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature);
      } catch {
        // workerd's node:crypto rejects a KeyObject inside the options object
        // (#3243); a JWK key is accepted by both runtimes.
        return nodeVerify(
          'sha256',
          data,
          { key: publicKey.export({ format: 'jwk' }), format: 'jwk', dsaEncoding: 'ieee-p1363' },
          signature
        );
      }
    }
    if (alg === 'rsa-pss-sha512') {
      // RFC 9421 §3.3.1; used by the Web Bot Auth profile only.
      return nodeVerify(
        'sha512',
        data,
        { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 64 },
        signature
      );
    }
    return false;
  } catch {
    // Malformed signature bytes, mismatched key/alg, etc. — map to a caller-
    // observable verify failure rather than letting an opaque crypto Error
    // escape the 12-step pipeline.
    return false;
  }
}

/** WebCrypto, when the runtime provides it (browsers, workerd, Deno, Node 20+). */
function subtleCrypto(): SubtleCrypto | undefined {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  return subtle && typeof subtle.importKey === 'function' ? subtle : undefined;
}
const P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const P256_SHA256 = { name: 'ECDSA', hash: 'SHA-256' } as const;
function publicP256Jwk(jwk: JsonWebKey): JsonWebKey {
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}
function privateP256Jwk(jwk: JsonWebKey): JsonWebKey {
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d };
}

/**
 * Verify with WebCrypto when available. ES256 uses `crypto.subtle`, whose
 * ECDSA signatures are IEEE P1363 (r||s) natively, so edge runtimes such as
 * Cloudflare workerd verify without node:crypto option-shape differences
 * (#3243). Other algorithms, and runtimes without WebCrypto, use
 * {@link verifySignature}.
 */
export async function verifySignatureAsync(
  alg: string,
  publicKey: KeyObject | AdcpJsonWebKey,
  data: Uint8Array,
  signature: Uint8Array
): Promise<boolean> {
  const subtle = subtleCrypto();
  const keyObject = (): KeyObject => (isKeyObject(publicKey) ? publicKey : jwkToPublicKey(publicKey));
  if (alg !== 'ecdsa-p256-sha256' || !subtle) return verifySignature(alg, keyObject(), data, signature);
  try {
    const jwk = isKeyObject(publicKey) ? publicKey.export({ format: 'jwk' }) : (publicKey as JsonWebKey);
    const key = await importP256VerifyKey(subtle, jwk);
    return await subtle.verify(P256_SHA256, key, toArrayBuffer(signature), toArrayBuffer(data));
  } catch {
    return false;
  }
}
function isKeyObject(value: unknown): value is KeyObject {
  return typeof (value as KeyObject | undefined)?.export === 'function' && 'asymmetricKeyType' in (value as object);
}
/** Imported verification keys, bounded; JWK import is the dominant per-call cost. */
const p256VerifyKeys = new Map<string, Promise<CryptoKey>>();
function importP256VerifyKey(subtle: SubtleCrypto, jwk: JsonWebKey): Promise<CryptoKey> {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string')
    return Promise.reject(new TypeError('Not a P-256 public key'));
  const cacheKey = `${jwk.x}.${jwk.y}`;
  let key = p256VerifyKeys.get(cacheKey);
  if (!key) {
    key = subtle.importKey('jwk', publicP256Jwk(jwk), P256, false, ['verify']);
    key.catch(() => p256VerifyKeys.delete(cacheKey));
    if (p256VerifyKeys.size >= 256) p256VerifyKeys.delete(p256VerifyKeys.keys().next().value!);
    p256VerifyKeys.set(cacheKey, key);
  }
  return key;
}

/**
 * Sign with a private JWK. ES256 output is IEEE P1363 (r||s). The node:crypto
 * path passes the key as a JWK so workerd accepts it (#3243).
 */
export function signWithPrivateJwk(alg: string, privateJwk: AdcpJsonWebKey, data: Uint8Array): Uint8Array {
  if (alg === 'ed25519')
    return new Uint8Array(nodeSign(null, data, createPrivateKey({ key: privateJwk, format: 'jwk' })));
  if (alg === 'ecdsa-p256-sha256')
    return new Uint8Array(nodeSign('sha256', data, { key: privateJwk, format: 'jwk', dsaEncoding: 'ieee-p1363' }));
  throw new TypeError(`Unsupported signing algorithm: ${alg}`);
}

/** {@link signWithPrivateJwk}, preferring WebCrypto for ES256 when available. */
export async function signWithPrivateJwkAsync(
  alg: string,
  privateJwk: AdcpJsonWebKey,
  data: Uint8Array
): Promise<Uint8Array> {
  const subtle = subtleCrypto();
  if (alg !== 'ecdsa-p256-sha256' || !subtle) return signWithPrivateJwk(alg, privateJwk, data);
  const key = await subtle.importKey('jwk', privateP256Jwk(privateJwk), P256, false, ['sign']);
  return new Uint8Array(await subtle.sign(P256_SHA256, key, toArrayBuffer(data)));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
