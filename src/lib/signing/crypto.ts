import { createPublicKey, verify as nodeVerify, type JsonWebKey, type KeyObject } from 'crypto';
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
      return nodeVerify('sha256', data, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature);
    }
    return false;
  } catch {
    // Malformed signature bytes, mismatched key/alg, etc. — map to a caller-
    // observable verify failure rather than letting an opaque crypto Error
    // escape the 12-step pipeline.
    return false;
  }
}
