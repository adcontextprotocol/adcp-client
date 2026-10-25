/**
 * The AdCP nonce is unpadded Base64URL containing at least 16 decoded bytes.
 * Check the alphabet before length: permissive Base64 decoders ignore invalid
 * characters and padding. 22 alphabet characters encode at least 16 bytes;
 * no decoded allocation is needed for an attacker-controlled header value.
 */
export function isValidSigningNonce(nonce: string): boolean {
  return nonce.length >= 22 && nonce.length % 4 !== 1 && !/[^A-Za-z0-9_-]/.test(nonce);
}
