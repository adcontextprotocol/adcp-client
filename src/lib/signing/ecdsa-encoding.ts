/**
 * Convert a DER-encoded ECDSA signature into the IEEE P1363 (`r‖s`) wire
 * format AdCP and RFC 9421 §3.3.1 require.
 *
 * Most KMS providers (GCP KMS `asymmetricSign`, AWS KMS `Sign` for ECDSA,
 * Azure Key Vault) return DER-encoded ECDSA signatures. The Node `crypto`
 * signer used by the in-memory path produces P1363 directly via
 * `dsaEncoding: 'ieee-p1363'`. KMS adapters need this helper to normalize
 * to the wire format peers expect.
 *
 * `componentLen` is the curve's coordinate width in bytes — 32 for P-256.
 *
 * Each component is left-padded to `componentLen` bytes; DER's leading-zero
 * padding (which exists to keep ASN.1 INTEGER positive) is stripped.
 *
 * Throws if the DER structure is malformed or a component exceeds the
 * declared component length.
 */
export function derEcdsaToP1363(der: Uint8Array, componentLen: number): Uint8Array {
  const readByte = (offset: number): number => {
    const v = der[offset];
    if (v === undefined) {
      throw new Error(`Malformed DER ECDSA signature: unexpected end of input at offset ${offset}.`);
    }
    return v;
  };

  if (der.length < 8 || readByte(0) !== 0x30) {
    throw new Error('Malformed DER ECDSA signature: missing SEQUENCE tag.');
  }
  let cursor = 2;
  const lengthByte = readByte(1);
  // SEQUENCE total-content length, used to validate the parsed contents
  // don't claim more bytes than the buffer holds.
  let sequenceContentLen: number;
  // P-256 ECDSA signatures are always short-form length encoded (<= 72 bytes
  // including header), so production callers never hit the long-form branch.
  // We still parse long-form defensively but reject anything that would put
  // cursor past the buffer.
  if ((lengthByte & 0x80) !== 0) {
    const skip = lengthByte & 0x7f;
    if (skip === 0 || skip > 4) {
      throw new Error('Malformed DER ECDSA signature: invalid long-form length.');
    }
    sequenceContentLen = 0;
    for (let i = 0; i < skip; i++) {
      sequenceContentLen = (sequenceContentLen << 8) | readByte(2 + i);
    }
    cursor = 2 + skip;
    if (cursor >= der.length) {
      throw new Error('Malformed DER ECDSA signature: long-form length runs past buffer.');
    }
  } else {
    sequenceContentLen = lengthByte;
  }
  if (cursor + sequenceContentLen > der.length) {
    throw new Error('Malformed DER ECDSA signature: SEQUENCE content runs past buffer.');
  }
  if (readByte(cursor) !== 0x02) {
    throw new Error('Malformed DER ECDSA signature: missing INTEGER tag for r.');
  }
  const rLen = readByte(cursor + 1);
  if (cursor + 2 + rLen > der.length) {
    throw new Error('Malformed DER ECDSA signature: r INTEGER length runs past buffer.');
  }
  let r = der.subarray(cursor + 2, cursor + 2 + rLen);
  cursor = cursor + 2 + rLen;
  if (readByte(cursor) !== 0x02) {
    throw new Error('Malformed DER ECDSA signature: missing INTEGER tag for s.');
  }
  const sLen = readByte(cursor + 1);
  if (cursor + 2 + sLen > der.length) {
    throw new Error('Malformed DER ECDSA signature: s INTEGER length runs past buffer.');
  }
  let s = der.subarray(cursor + 2, cursor + 2 + sLen);

  if (r.length > componentLen && r[0] === 0x00) r = r.subarray(1);
  if (s.length > componentLen && s[0] === 0x00) s = s.subarray(1);

  if (r.length > componentLen || s.length > componentLen) {
    throw new Error(`DER ECDSA component longer than expected ${componentLen}-byte wire format.`);
  }
  const out = new Uint8Array(componentLen * 2);
  out.set(r, componentLen - r.length);
  out.set(s, componentLen * 2 - s.length);
  return out;
}
