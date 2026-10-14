// Regression tests for identity hardening follow-ups to #3244 (refs #3233).
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const wba = require('../../dist/lib/signing/web-bot-auth');
const identity = require('../../dist/lib/identity-3.3');
const { parseSignatureInput, parseSignature, rejectDuplicateDictionaryKeys } = require('../../dist/lib/signing/parser');
const {
  InMemoryReplayStore,
  InMemoryRevocationStore,
  StaticJwksResolver,
  signRequest,
  verifyRequestSignature,
} = require('../../dist/lib/signing/index.js');
const { createExpressVerifier } = require('../../dist/lib/signing/server');

const T = 1790841610;

function evaluator(records, options = {}) {
  return new identity.TrustEvaluator({
    now: () => T,
    ...options,
    fetchOptions: {
      trustedFetchFn: async url => {
        const record = records[new URL(url).hostname];
        return new Response(record === undefined ? '' : JSON.stringify(record), {
          status: record === undefined ? 404 : 200,
        });
      },
    },
  });
}
const listing = host => ({ agents: [{ url: `https://agent.${host}`, roles: ['adcp:buying'] }] });

test('authority history: free hosting subdomains cannot disable legacy fallback for other operators', async () => {
  const records = { 'auth.com': listing('auth.com') };
  for (let i = 0; i < 10; i++) records[`a${i}.vercel.app`] = listing(`a${i}.vercel.app`);
  const trust = evaluator(records, { maxEntries: 5, maxAuthoritativeOperatorsPerPrivateSuffix: 3 });
  assert.equal((await trust.get('auth.com')).status, 'present');
  let refused = 0;
  for (let i = 0; i < 10; i++) await trust.get(`a${i}.vercel.app`).catch(() => refused++);
  // Only the suffix budget is admitted; the rest of that suffix is refused, nothing is evicted.
  assert.equal(refused, 7);
  // An operator that never published a trust record keeps its legacy (absent) status.
  assert.equal((await trust.get('legacy.com')).status, 'absent');
  // An earlier authoritative operator still cannot downgrade to legacy.
  delete records['auth.com'];
  trust.invalidate('auth.com');
  await assert.rejects(trust.get('auth.com'));
});

test('authority history: the total cap refuses newcomers instead of evicting history', async () => {
  const records = {};
  for (let i = 0; i < 4; i++) records[`op${i}.com`] = listing(`op${i}.com`);
  const trust = evaluator(records, { maxEntries: 3 });
  for (let i = 0; i < 3; i++) assert.equal((await trust.get(`op${i}.com`)).status, 'present');
  await assert.rejects(trust.get('op3.com'));
  // op0's history survives: a 404 is still not a legacy downgrade.
  delete records['op0.com'];
  trust.invalidate('op0.com');
  await assert.rejects(trust.get('op0.com'));
  assert.equal((await trust.get('never.com')).status, 'absent');
});

test('authority history: durable history keeps working past the in-memory bound', async () => {
  const seen = new Set();
  const authorityHistory = {
    has: async operator => seen.has(operator),
    mark: async operator => void seen.add(operator),
  };
  const records = {};
  for (let i = 0; i < 5; i++) records[`op${i}.com`] = listing(`op${i}.com`);
  const trust = evaluator(records, { maxEntries: 2, authorityHistory });
  for (let i = 0; i < 5; i++) assert.equal((await trust.get(`op${i}.com`)).status, 'present');
  delete records['op0.com'];
  trust.invalidate('op0.com');
  await assert.rejects(trust.get('op0.com'));
});

const duplicateCases = [
  'sig1=("@method");created=1;created=2;keyid="k"',
  'sig1=("@method" "x";key="a";key="b");created=1',
  'sig1=("@method");created=1, sig1=("@authority");created=1',
  'sig1=("@method");keyid="a";KEYID="b"',
  'a=1;p=1;p=2',
  'sig1=:AQ==:;x=1;x=2',
];
const acceptedCases = [
  'sig1=("@method" "x";key="a" "y";key="a");created=1;keyid="k"',
  'sig1=("@method");created=1, sig2=("@method");created=1',
  'sig1="https://a.example";type="directory", sig2="https://b.example";type="directory"',
  'sig1=("x;y" "z");created=1;nonce="a;b=c;b=d"',
];

test('structured fields: duplicate members or parameters are malformed, distinct ones are not', () => {
  for (const value of duplicateCases)
    assert.throws(
      () => rejectDuplicateDictionaryKeys(value, 'Signature-Input'),
      e => e.code === 'request_signature_header_malformed',
      value
    );
  for (const value of acceptedCases) assert.doesNotThrow(() => rejectDuplicateDictionaryKeys(value, 'X'), value);
  assert.throws(
    () => parseSignatureInput('sig1=("@method");created=1;created=2;keyid="k"', 'sig1'),
    e => e.code === 'request_signature_header_malformed'
  );
  assert.throws(
    () => parseSignature('sig1=:AQ==:;x=1;x=2', 'sig1', 'rfc8941-base64'),
    e => e.code === 'request_signature_header_malformed'
  );
});

test('RFC 9421 verifier rejects a duplicated signature parameter before verification', async () => {
  const keys = JSON.parse(
    readFileSync(path.join(__dirname, '../../compliance/cache/latest/test-vectors/request-signing/keys.json'), 'utf8')
  ).keys;
  const ed = keys.find(k => k.kid === 'test-ed25519-2026');
  const privateJwk = { ...ed, d: ed._private_d_for_test_only };
  for (const field of ['_private_d_for_test_only', 'key_ops', 'use']) delete privateJwk[field];
  const publicJwk = { ...ed };
  delete publicJwk._private_d_for_test_only;
  const url = 'https://seller.example.com/adcp/create_media_buy';
  const body = '{"plan_id":"plan_001"}';
  const created = 1_776_520_800;
  const signed = signRequest(
    { method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body },
    { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: privateJwk },
    { now: () => created, windowSeconds: 300 }
  );
  const inputName = Object.keys(signed.headers).find(name => name.toLowerCase() === 'signature-input');
  const headers = { ...signed.headers, [inputName]: `${signed.headers[inputName]};created=${created - 100}` };
  await assert.rejects(
    verifyRequestSignature(
      { method: 'POST', url, headers, body },
      {
        adcpVersion: '3.1',
        capability: { supported: true, covers_content_digest: 'either', required_for: [] },
        jwks: new StaticJwksResolver([publicJwk]),
        replayStore: new InMemoryReplayStore(),
        revocationStore: new InMemoryRevocationStore(),
        now: () => created,
        operation: 'create_media_buy',
      }
    ),
    e => e.code === 'request_signature_header_malformed'
  );
});

test('Web Bot Auth verifier rejects duplicated parameters and Signature-Agent members with 400', async () => {
  const key = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  key.kid = wba.jwkThumbprint(key);
  const origin = 'https://buyer.example.com';
  const proof = await wba.createSignedSignatureDirectory(origin, [{ privateKey: key }], { now: () => T });
  const request = {
    method: 'POST',
    url: 'https://seller.example.com/mcp',
    headers: { 'content-type': 'application/json' },
    body: '{"a":1}',
  };
  const headers = await wba.signWebBotAuth(request, { privateKey: key }, { origin, now: () => T });
  const options = () => ({
    directory: new wba.SignatureDirectoryResolver({
      now: () => T,
      fetchOptions: {
        trustedFetchFn: async () => new Response(proof.body, { status: 200, headers: proof.headers }),
      },
    }),
    replayStore: new InMemoryReplayStore(),
    isRevoked: async () => false,
    now: () => T,
  });
  for (const mutated of [
    { ...headers, 'signature-input': `${headers['signature-input']};created=${T - 1}` },
    { ...headers, 'signature-agent': `${headers['signature-agent']}, sig1="https://evil.example.com"` },
    { ...headers, 'signature-agent': `${headers['signature-agent']};type="directory";type="other"` },
  ])
    await assert.rejects(wba.verifyWebBotAuth({ ...request, headers: mutated }, options()), e => e.status === 400);
  assert.equal((await wba.verifyWebBotAuth({ ...request, headers }, options())).length, 1);
});

test('createExpressVerifier refuses Web Bot Auth requests instead of verifying them as RFC 9421', async () => {
  const middleware = createExpressVerifier({
    capability: { supported: true, covers_content_digest: 'either', required_for: [] },
    jwks: new StaticJwksResolver([]),
    resolveOperation: () => 'get_products',
    adcpVersion: '3.1',
  });
  const run = async headers => {
    const response = {};
    let nextCalled = false;
    await middleware(
      { method: 'POST', url: '/mcp', headers, rawBody: '{}', protocol: 'https', get: () => 'seller.example.com' },
      {
        status(code) {
          response.status = code;
          return {
            set(name, value) {
              response.headers = { [name]: value };
              return { json: body => (response.body = body) };
            },
          };
        },
      },
      () => (nextCalled = true)
    );
    return { response, nextCalled };
  };
  for (const headers of [
    { 'signature-agent': 'sig1="https://buyer.example.com"' },
    { 'signature-input': 'sig1=("@method");created=1;tag="web-bot-auth"', signature: 'sig1=:AQ==:' },
  ]) {
    const { response, nextCalled } = await run(headers);
    assert.equal(nextCalled, false);
    assert.equal(response.status, 403);
    assert.equal(response.headers['Accept-Signature'], undefined);
    assert.match(response.body.message, /Web Bot Auth is not configured/);
  }
  // Unsigned requests are unaffected.
  assert.equal((await run({})).nextCalled, true);
});
