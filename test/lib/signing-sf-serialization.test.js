// Structured-field serialization of the RFC 9421 signer fields comes from
// structured-headers (library-first). These pin the behaviour the vectors do
// not exercise: offset views, ArrayBuffer provider output, escaping and the
// up-front label and clock checks.
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeContentDigest,
  finalizeRequestSignature,
  formatSignatureParams,
  parseSignatureInput,
  prepareRequestSignature,
} = require('../../dist/lib/signing/index.js');

const request = {
  method: 'POST',
  url: 'https://seller.example.com/mcp',
  headers: { 'content-type': 'application/json' },
  body: '{}',
};
const identity = { keyid: 'kid-1', alg: 'ed25519' };
const params = { created: 1, expires: 2, nonce: 'n', keyid: 'k', alg: 'ed25519', tag: 't' };

test('Signature serializes exactly the bytes of a view at a non-zero offset, and an ArrayBuffer', () => {
  const backing = new Uint8Array(200).map((_, i) => i);
  const view = backing.subarray(7, 71);
  const expected = Buffer.from(view);
  for (const binaryEncoding of ['rfc8941-base64', 'legacy-base64url']) {
    const prepared = prepareRequestSignature(request, identity, { binaryEncoding, now: () => 100 });
    const encoded = expected.toString(binaryEncoding === 'legacy-base64url' ? 'base64url' : 'base64');
    assert.equal(finalizeRequestSignature(prepared, view).headers.Signature, `sig1=:${encoded}:`);
    const arrayBuffer = expected.buffer.slice(expected.byteOffset, expected.byteOffset + expected.byteLength);
    assert.equal(finalizeRequestSignature(prepared, arrayBuffer).headers.Signature, `sig1=:${encoded}:`);
  }
});

test('Content-Digest hashes the view, not its backing buffer', () => {
  const backing = Buffer.from('xx{"a":1}yy');
  const view = backing.subarray(2, 9);
  assert.equal(computeContentDigest(view), computeContentDigest('{"a":1}'));
  assert.match(computeContentDigest('{}'), /^sha-256=:[A-Za-z0-9+/]{43}=:$/);
  assert.match(computeContentDigest('{}', 'legacy-base64url'), /^sha-256=:[A-Za-z0-9_-]{43}:$/);
});

test('string parameters are escaped and round-trip through the verifier parser', () => {
  const value = formatSignatureParams(['@method', 'authorization;req'], { ...params, nonce: 'a"b\\c' });
  assert.equal(
    value,
    '("@method" "authorization";req);created=1;expires=2;nonce="a\\"b\\\\c";keyid="k";alg="ed25519";tag="t"'
  );
  assert.equal(parseSignatureInput(`sig1=${value}`).params.nonce, 'a"b\\c');
});

test('values that cannot form an RFC 8941 field are caller errors', () => {
  assert.throws(() => formatSignatureParams(['@method'], { ...params, keyid: 'ké' }), TypeError);
  assert.throws(() => prepareRequestSignature(request, identity, { label: 'Sig1' }), /not an RFC 8941 key/);
  assert.throws(() => prepareRequestSignature(request, identity, { now: () => 1.5 }), /integer epoch seconds/);
});
