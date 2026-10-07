/**
 * GHSA-frxv-c96c-4vqw: `requireSignatureWhenPresent` / `requireAuthenticatedOrSigned`
 * must enforce `requiredFor` on A2A bodies, fail closed on an unresolvable body,
 * and run the same unsigned checks (`protocol_methods_required_for`, webhook
 * authentication) as the verifier's unsigned branch.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const {
  AuthError,
  verifyApiKey,
  verifySignatureAsAuthenticator,
  requireSignatureWhenPresent,
  requireAuthenticatedOrSigned,
  adcpOperationResolver,
  mcpToolNameResolver,
  anyOf,
} = require('../dist/lib/server/legacy/v5/index.js');
const { UNRESOLVABLE_OPERATION } = require('../dist/lib/signing/server.js');
const { RequestSignatureError } = require('../dist/lib/signing/errors.js');
const {
  signRequest,
  InMemoryReplayStore,
  InMemoryRevocationStore,
  StaticJwksResolver,
} = require('../dist/lib/signing/index.js');

const keysPath = path.join(
  __dirname,
  '..',
  'compliance',
  'cache',
  'latest',
  'test-vectors',
  'request-signing',
  'keys.json'
);
const { keys } = JSON.parse(readFileSync(keysPath, 'utf8'));
const primary = keys.find(k => k.kid === 'test-ed25519-2026');
const publicJwk = { ...primary };
delete publicJwk._private_d_for_test_only;
const privateJwk = { ...primary, d: primary._private_d_for_test_only };
delete privateJwk._private_d_for_test_only;

const NOW = 1_776_520_800;
const URL_ = 'https://seller.example.com/a2a';

const signatureAuth = () =>
  verifySignatureAsAuthenticator({
    jwks: new StaticJwksResolver([publicJwk]),
    replayStore: new InMemoryReplayStore(),
    revocationStore: new InMemoryRevocationStore(),
    capability: { supported: true, covers_content_digest: 'required', required_for: ['create_media_buy'] },
    adcpVersion: '3.2.0',
    now: () => NOW,
    resolveOperation: adcpOperationResolver,
    getUrl: () => URL_,
  });
const bearer = verifyApiKey({ keys: { sk_good: { principal: 'acct_42' } } });

const sendMessage = (skill, input = {}, method = 'SendMessage') =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method,
    params: { message: { messageId: 'm', role: 'ROLE_USER', parts: [{ data: { skill, input } }] } },
  });

function req(body, headers = {}) {
  return { method: 'POST', url: '/a2a', headers: { host: 'seller.example.com', ...headers }, rawBody: body };
}

function signedReq(body, nonce) {
  const signed = signRequest(
    { method: 'POST', url: URL_, headers: { 'Content-Type': 'application/json' }, body },
    { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: privateJwk },
    { now: () => NOW, windowSeconds: 300, nonce, coverContentDigest: true, binaryEncoding: 'rfc8941-base64' }
  );
  const headers = { host: 'seller.example.com' };
  for (const [k, v] of Object.entries(signed.headers)) headers[k.toLowerCase()] = v;
  return { method: 'POST', url: '/a2a', headers, rawBody: body };
}

const code = err => err instanceof AuthError && err.cause instanceof RequestSignatureError && err.cause.code;

describe('requireSignatureWhenPresent with the A2A-aware resolver', () => {
  const gate = (options = {}) =>
    requireSignatureWhenPresent(signatureAuth(), anyOf(bearer), {
      requiredFor: ['create_media_buy'],
      resolveOperation: adcpOperationResolver,
      ...options,
    });

  it('rejects an unsigned, unauthenticated A2A create_media_buy', async () => {
    await assert.rejects(
      () => gate()(req(sendMessage('create_media_buy'))),
      err => code(err) === 'request_signature_required'
    );
  });

  it('rejects an unsigned A2A create_media_buy carrying an unrecognized bearer, as request_signature_required', async () => {
    await assert.rejects(
      () => gate()(req(sendMessage('create_media_buy'), { authorization: 'Bearer junk' })),
      err => code(err) === 'request_signature_required'
    );
  });

  it('lets a valid bearer satisfy required_for (adcp#2586 fallback bypass is unchanged)', async () => {
    const result = await gate()(req(sendMessage('create_media_buy'), { authorization: 'Bearer sk_good' }));
    assert.strictEqual(result.principal, 'acct_42');
  });

  it('passes an unsigned A2A get_products with a bearer, and returns null with no credentials', async () => {
    const withBearer = await gate()(req(sendMessage('get_products'), { authorization: 'Bearer sk_good' }));
    assert.strictEqual(withBearer.principal, 'acct_42');
    assert.strictEqual(await gate()(req(sendMessage('get_products'))), null);
  });

  it('verifies a signed A2A create_media_buy', async () => {
    const request = signedReq(sendMessage('create_media_buy'), 'a2a-composer-valid-0001');
    const result = await gate()(request);
    assert.strictEqual(result.principal, 'signing:test-ed25519-2026');
  });

  it('treats an unresolvable body as malformed even with a valid bearer', async () => {
    const twoParts = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: {
        message: {
          parts: [{ data: { skill: 'get_products', input: {} } }, { data: { skill: 'create_media_buy', input: {} } }],
        },
      },
    });
    await assert.rejects(
      () => gate()(req(twoParts, { authorization: 'Bearer sk_good' })),
      err => code(err) === 'request_body_malformed'
    );
    await assert.rejects(
      () => gate({ requiredFor: [] })(req(twoParts)),
      err => code(err) === 'request_body_malformed',
      'fails closed even when requiredFor is empty'
    );
  });

  it('reports request_body_malformed before the signature-header check', async () => {
    const dup =
      '{"jsonrpc":"2.0","method":"SendMessage","params":{"message":{"parts":[{"data":{"skill":"a","skill":"create_media_buy"}}]}}}';
    await assert.rejects(
      () => gate()(req(dup, { signature: 'sig1=:AAAA:' })),
      err => code(err) === 'request_body_malformed'
    );
    await assert.rejects(
      () => gate()(signedReq(dup, 'a2a-composer-dup-0001')),
      err => code(err) === 'request_body_malformed'
    );
  });

  it('defaults the resolver when requiredFor is set and no resolver is given', async () => {
    const noResolver = requireSignatureWhenPresent(signatureAuth(), anyOf(bearer), {
      requiredFor: ['create_media_buy'],
    });
    await assert.rejects(
      () => noResolver(req(sendMessage('create_media_buy'))),
      err => code(err) === 'request_signature_required'
    );
  });

  it('requireAuthenticatedOrSigned forwards the same options', async () => {
    const composed = requireAuthenticatedOrSigned({
      signature: signatureAuth(),
      fallback: anyOf(bearer),
      requiredFor: ['create_media_buy'],
      protocolMethodsRequiredFor: ['CancelTask'],
    });
    await assert.rejects(
      () => composed(req(sendMessage('create_media_buy'))),
      err => code(err) === 'request_signature_required'
    );
    await assert.rejects(
      () => composed(req(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'CancelTask', params: { id: 't' } }))),
      err => code(err) === 'request_signature_required'
    );
  });

  it('keeps the legacy fail-open when a caller pins mcpToolNameResolver (documented MCP-only resolver)', async () => {
    const legacy = requireSignatureWhenPresent(signatureAuth(), anyOf(bearer), {
      requiredFor: ['create_media_buy'],
      resolveOperation: mcpToolNameResolver,
    });
    assert.strictEqual(await legacy(req(sendMessage('create_media_buy'))), null);
  });

  it('honors a custom resolver returning UNRESOLVABLE_OPERATION', async () => {
    const composed = requireSignatureWhenPresent(signatureAuth(), anyOf(bearer), {
      requiredFor: [],
      resolveOperation: () => UNRESOLVABLE_OPERATION,
    });
    await assert.rejects(
      () => composed(req('{}')),
      err => code(err) === 'request_body_malformed'
    );
  });
});

describe('requireSignatureWhenPresent runs the verifier’s unsigned-branch checks', () => {
  const composed = (options = {}) =>
    requireSignatureWhenPresent(signatureAuth(), anyOf(bearer), {
      requiredFor: ['create_media_buy'],
      protocolMethodsRequiredFor: ['CancelTask', 'tasks/cancel'],
      resolveOperation: adcpOperationResolver,
      ...options,
    });

  it('rejects an unsigned listed protocol method with no credentials', async () => {
    for (const method of ['CancelTask', 'tasks/cancel']) {
      await assert.rejects(
        () => composed()(req(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { id: 't' } }))),
        err => code(err) === 'request_signature_required',
        method
      );
    }
  });

  it('lets a valid bearer satisfy protocol_methods_required_for, like required_for', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'CancelTask', params: { id: 't' } });
    const result = await composed()(req(body, { authorization: 'Bearer sk_good' }));
    assert.strictEqual(result.principal, 'acct_42');
  });

  it('does not match protocol methods against the resolved operation, nor operations against methods', async () => {
    // `CancelTask` listed as a protocol method must not fire on a tools/call named CancelTask.
    const mcp = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'CancelTask' } });
    assert.strictEqual(await composed()(req(mcp)), null);
    // `create_media_buy` as a JSON-RPC method string is not the operation.
    const odd = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'create_media_buy', params: {} });
    assert.strictEqual(await composed()(req(odd)), null);
  });

  it('requires a signature for webhook authentication even when the caller holds a valid bearer', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          push_notification_config: {
            url: 'https://hooks.example/x',
            authentication: { schemes: ['Bearer'], credentials: 'x'.repeat(40) },
          },
        },
      },
    });
    await assert.rejects(
      () => composed()(req(body, { authorization: 'Bearer sk_good' })),
      err => code(err) === 'request_signature_required'
    );
  });
});
