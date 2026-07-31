/**
 * `createExpressVerifier` must never verify a signature against a body it did
 * not actually see.
 *
 * When `req.rawBody` is absent the middleware has nothing authentic to
 * canonicalize. Returning `''` in that case does not merely weaken the check —
 * it makes the whole pipeline describe an empty surrogate: `hasBody` is derived
 * from the same value, so the `content-type` coverage requirement lapses, and a
 * `content-digest` comparison would hash `''`. The middleware then calls
 * `next()` and a body parser downstream hands the real payload to the handler.
 *
 * So every signal that a body exists has to fail closed. `Content-Length` alone
 * is not one of those signals: chunked transfers carry no `Content-Length`.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const { createExpressVerifier } = require('../../dist/lib/signing/middleware.js');

function makeVerifier() {
  return createExpressVerifier({
    // Reached only if the raw-body guard lets the request through, which is
    // exactly what these tests assert must not happen.
    jwks: { resolve: async () => null },
    resolveOperation: () => 'create_media_buy',
    getUrl: () => 'https://seller.example.com/mcp',
  });
}

/** Capture whichever of (next, 401 response) the middleware reaches. */
async function run(req) {
  const outcome = { nextCalled: false, nextErr: undefined, status: undefined, body: undefined };
  const res = {
    status(code) {
      outcome.status = code;
      return {
        set() {
          return {
            json(body) {
              outcome.body = body;
            },
          };
        },
      };
    },
  };
  await makeVerifier()(req, res, err => {
    outcome.nextCalled = true;
    outcome.nextErr = err;
  });
  return outcome;
}

const SIGNED_HEADERS = {
  signature: 'sig1=:AAAA:',
  'signature-input': 'sig1=("@method" "@target-uri");created=1;keyid="k1";alg="ed25519"',
};

describe('createExpressVerifier: raw-body guard', () => {
  test('rejects a chunked request with no rawBody instead of verifying against an empty body', async () => {
    // The regression: `Transfer-Encoding: chunked` requests have no
    // Content-Length, so a length-only test skipped the guard entirely.
    const outcome = await run({
      method: 'POST',
      url: '/mcp',
      headers: {
        ...SIGNED_HEADERS,
        'content-type': 'application/json',
        'transfer-encoding': 'chunked',
      },
    });

    assert.strictEqual(outcome.status, 401, 'chunked body without rawBody must be refused');
    assert.strictEqual(outcome.body?.error, 'request_signature_header_malformed');
    assert.strictEqual(outcome.nextCalled, false, 'must not fall through to downstream handlers');
  });

  test('rejects when a body parser already populated req.body but rawBody is absent', async () => {
    // A parser mounted ahead of the verifier consumed the stream, so the real
    // payload exists even though this middleware cannot see its bytes.
    const outcome = await run({
      method: 'POST',
      url: '/mcp',
      headers: { ...SIGNED_HEADERS, 'content-type': 'application/json' },
      body: { tool: 'create_media_buy', total_budget: 50000 },
    });

    assert.strictEqual(outcome.status, 401, 'a parsed-but-uncaptured body must be refused');
    assert.strictEqual(outcome.body?.error, 'request_signature_header_malformed');
    assert.strictEqual(outcome.nextCalled, false);
  });

  test('still rejects the plain Content-Length case', async () => {
    const outcome = await run({
      method: 'POST',
      url: '/mcp',
      headers: { ...SIGNED_HEADERS, 'content-type': 'application/json', 'content-length': '42' },
    });

    assert.strictEqual(outcome.status, 401);
    assert.strictEqual(outcome.body?.error, 'request_signature_header_malformed');
  });

  test('rejects an unparseable Content-Length rather than reading it as zero', async () => {
    const outcome = await run({
      method: 'POST',
      url: '/mcp',
      headers: { ...SIGNED_HEADERS, 'content-type': 'application/json', 'content-length': 'not-a-number' },
    });

    assert.strictEqual(outcome.status, 401);
    assert.strictEqual(outcome.body?.error, 'request_signature_header_malformed');
  });

  test('treats Content-Length: 00 as zero, not as a body', async () => {
    // llhttp accepts `00`; a string compare against '0' would 401 a legitimate
    // bodiless signed request.
    const outcome = await run({
      method: 'GET',
      url: '/mcp',
      headers: { ...SIGNED_HEADERS, 'content-length': '00' },
    });

    assert.notStrictEqual(outcome.body?.error, 'request_signature_header_malformed');
  });

  test('rejects a POST with no body headers at all (HTTP/2 shape)', async () => {
    // HTTP/2 forbids Transfer-Encoding and makes content-length optional, so a
    // DATA-frame body arrives with neither header. Enumerating body signals
    // could not catch this; requiring rawBody for body-bearing methods does.
    const outcome = await run({
      method: 'POST',
      url: '/mcp',
      headers: { ...SIGNED_HEADERS, 'content-type': 'application/json' },
    });

    assert.strictEqual(outcome.status, 401, 'a body-bearing method must supply rawBody');
    assert.strictEqual(outcome.body?.error, 'request_signature_header_malformed');
    assert.strictEqual(outcome.nextCalled, false);
  });

  test('accepts a Buffer rawBody, which is what express.json({ verify }) yields', async () => {
    // The canonical recipe hands back the raw Buffer; 401-ing a correctly wired
    // app was its own bug.
    const outcome = await run({
      method: 'POST',
      url: '/mcp',
      headers: { ...SIGNED_HEADERS, 'content-type': 'application/json' },
      rawBody: Buffer.from('{"tool":"create_media_buy"}', 'utf8'),
    });

    assert.notStrictEqual(
      outcome.body?.error,
      'request_signature_header_malformed',
      'a Buffer rawBody must be accepted, not treated as missing'
    );
  });

  test('a genuinely bodiless request is not refused by the guard', async () => {
    // GET with an explicit zero length is the only shape that can honestly
    // verify against `''`, so it must reach signature verification. It fails
    // later at key resolution, which proves it got past the guard.
    const outcome = await run({
      method: 'GET',
      url: '/mcp',
      headers: { ...SIGNED_HEADERS, 'content-length': '0' },
    });

    assert.strictEqual(outcome.status, 401);
    assert.notStrictEqual(
      outcome.body?.error,
      'request_signature_header_malformed',
      'a bodiless request must reach verification, not trip the raw-body guard'
    );
  });

  test('an empty parsed body object does not trip the guard', async () => {
    // Express sets `req.body = {}` for bodiless requests when a JSON parser is
    // mounted; that must not be read as "a body exists".
    const outcome = await run({
      method: 'GET',
      url: '/mcp',
      headers: { ...SIGNED_HEADERS },
      body: {},
    });

    assert.notStrictEqual(outcome.body?.error, 'request_signature_header_malformed');
  });
});
