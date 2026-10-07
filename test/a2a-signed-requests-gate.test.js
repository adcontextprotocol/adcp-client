/**
 * GHSA-frxv-c96c-4vqw / adcp#7820 regression tests.
 *
 * A seller that configures `createAdcpServer({ signedRequests })` and mounts
 * `createA2AAdapter` must enforce `request_signing.required_for` over A2A the
 * same way it does over MCP: the operation is the `skill` of the Message's sole
 * DataPart, and a body that does not resolve to exactly one operation fails
 * closed. See adcp#7945 ("Operation resolution over A2A").
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const express = require('express');
const { InMemoryTaskStore } = require('@a2a-js/sdk/server');
const { Role, TaskState } = require('@a2a-js/sdk');

const { createAdcpServer: _createAdcpServer } = require('../dist/lib/server/create-adcp-server');
const { createA2AAdapter } = require('../dist/lib/server/a2a-adapter');
const { InMemoryStateStore } = require('../dist/lib/server/state-store');
const { StaticJwksResolver, InMemoryReplayStore, InMemoryRevocationStore } = require('../dist/lib/signing/server.js');
const { signRequest } = require('../dist/lib/signing/signer.js');

const KEYS_PATH = path.join(
  __dirname,
  '..',
  'compliance',
  'cache',
  'latest',
  'test-vectors',
  'request-signing',
  'keys.json'
);
const keys = JSON.parse(readFileSync(KEYS_PATH, 'utf8')).keys;
const edRaw = keys.find(k => k.kid === 'test-ed25519-2026');
const edPublic = { ...edRaw };
delete edPublic._private_d_for_test_only;
const edPrivate = { ...edRaw, d: edRaw._private_d_for_test_only };
delete edPrivate._private_d_for_test_only;
delete edPrivate.key_ops;
delete edPrivate.use;

const AGENT_URL = 'https://seller.example.com/a2a';
const ADCP_EXTENSION = 'https://adcontextprotocol.org/extensions/adcp/v3';

function makeStores() {
  return {
    jwks: new StaticJwksResolver([edPublic]),
    replayStore: new InMemoryReplayStore({ maxEntriesPerKeyid: 100 }),
    revocationStore: new InMemoryRevocationStore({
      issuer: 'http://seller.example.com',
      updated: new Date().toISOString(),
      next_update: new Date(Date.now() + 3600_000).toISOString(),
      revoked_kids: [],
      revoked_jtis: [],
    }),
  };
}

/** Seller fixture. `calls` records every handler entry so tests can assert "never dispatched". */
function makeSeller({ signedRequests = {}, specialisms = ['signed-requests'], extra = {} } = {}) {
  const calls = { createMediaBuy: [], getProducts: 0 };
  const server = _createAdcpServer({
    name: 'A2A Signed Seller',
    version: '1.0.0',
    stateStore: new InMemoryStateStore(),
    validation: { requests: 'off', responses: 'off' },
    resolveAccount: ref => (ref ? { account_id: ref.account_id ?? 'acct_1', status: 'active' } : undefined),
    mediaBuy: {
      getProducts: async () => {
        calls.getProducts += 1;
        return { products: [] };
      },
      createMediaBuy: async (params, ctx) => {
        calls.createMediaBuy.push({ params, authInfo: ctx?.authInfo });
        return {
          media_buy_id: 'mb-123',
          status: 'active',
          confirmed_at: new Date().toISOString(),
          revision: 1,
          packages: [],
        };
      },
    },
    capabilities: {
      features: { inlineCreativeManagement: false },
      request_signing: { supported: true, covers_content_digest: 'required', required_for: ['create_media_buy'] },
      specialisms,
    },
    ...(signedRequests === null
      ? {}
      : { signedRequests: { ...makeStores(), required_for: ['create_media_buy'], ...signedRequests } }),
    ...extra,
  });
  return { server, calls };
}

async function listen(app) {
  const srv = app.listen(0);
  if (!srv.listening) await new Promise(resolve => srv.once('listening', resolve));
  return srv;
}

async function startAdapter({ seller, adapterOptions = {}, app = express(), mountPath = '/a2a', preMount } = {}) {
  const a2a = createA2AAdapter({
    server: seller.server,
    taskStore: adapterOptions.taskStore ?? new InMemoryTaskStore(),
    agentCard: { name: 'Seller', description: 'Seller', url: AGENT_URL, version: '1.0.0' },
    ...adapterOptions,
  });
  if (preMount) preMount(app, a2a);
  a2a.mount(app, { basePath: mountPath });
  const srv = await listen(app);
  return { a2a, srv, url: `http://127.0.0.1:${srv.address().port}${mountPath}` };
}

const stop = srv => new Promise(resolve => srv.close(() => resolve()));

const CREATE_INPUT = {
  idempotency_key: 'a2a-signed-gate-test-0001',
  account: { account_id: 'acct_1' },
  packages: [{ product_id: 'prod-1', budget: 5000, pricing_option_id: 'cpm_usd_fixed' }],
  brand: { domain: 'brand.example' },
  start_time: '2027-01-04T00:00:00Z',
  end_time: '2027-02-01T00:00:00Z',
};

const v1Headers = { 'A2A-Version': '1.0', 'A2A-Extensions': ADCP_EXTENSION };

function sendMessage(skill, input, { method = 'SendMessage', id = 'req-1' } = {}) {
  const legacy = method === 'message/send' || method === 'message/stream';
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: {
      message: legacy
        ? { kind: 'message', messageId: `m-${id}`, role: 'user', parts: [{ kind: 'data', data: { skill, input } }] }
        : { messageId: `m-${id}`, role: 'ROLE_USER', parts: [{ data: { skill, input } }] },
    },
  });
}

/** POST to the adapter, optionally signing for the public agent URL (the seller binds signatures to it). */
async function post(url, body, { sign = false, headers = {}, nonce, signUrl = AGENT_URL } = {}) {
  const requestHeaders = { 'Content-Type': 'application/json', ...v1Headers, ...headers };
  if (sign) {
    const signOpts = { coverContentDigest: true, binaryEncoding: 'rfc8941-base64' };
    if (nonce !== undefined) signOpts.nonce = nonce;
    const signed = signRequest(
      { method: 'POST', url: signUrl, headers: requestHeaders, body },
      { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: edPrivate },
      signOpts
    );
    Object.assign(requestHeaders, signed.headers);
  }
  const res = await fetch(url, { method: 'POST', headers: requestHeaders, body });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, challenge: res.headers.get('www-authenticate') };
}

function assertSignatureRejection(res, code) {
  assert.strictEqual(res.status, 401, `expected 401, got ${res.status}: ${res.text}`);
  assert.strictEqual(res.json?.error, code);
  assert.strictEqual(res.challenge, `Signature error="${code}"`);
}

describe('createAdcpServer({ signedRequests }) + createA2AAdapter', () => {
  let seller;
  let started;

  beforeEach(async () => {
    if (started) await stop(started.srv);
    seller = makeSeller();
    started = await startAdapter({ seller });
  });
  after(async () => {
    if (started) await stop(started.srv);
  });

  describe('unsigned create_media_buy is rejected (the adcp#7820 bypass)', () => {
    for (const method of ['SendMessage', 'SendStreamingMessage', 'message/send', 'message/stream']) {
      it(`rejects an unsigned, unauthenticated ${method}`, async () => {
        const res = await post(started.url, sendMessage('create_media_buy', CREATE_INPUT, { method }));
        assertSignatureRejection(res, 'request_signature_required');
        assert.strictEqual(seller.calls.createMediaBuy.length, 0, 'handler must never run');
      });
    }

    it('rejects an unsigned request even when the A2A-Extensions header is omitted', async () => {
      const res = await post(started.url, sendMessage('create_media_buy', CREATE_INPUT), {
        headers: { 'A2A-Extensions': '' },
      });
      assertSignatureRejection(res, 'request_signature_required');
      assert.strictEqual(seller.calls.createMediaBuy.length, 0);
    });

    it('rejects unsigned create_media_buy carrying a bearer in the strict posture, without consulting authenticate', async () => {
      await stop(started.srv);
      let authenticateCalls = 0;
      started = await startAdapter({
        seller,
        adapterOptions: {
          authenticate: async req => {
            authenticateCalls += 1;
            return req.headers.authorization === 'Bearer good'
              ? { token: 'good', clientId: 'buyer_1', scopes: [] }
              : null;
          },
        },
      });
      const res = await post(started.url, sendMessage('create_media_buy', CREATE_INPUT), {
        headers: { Authorization: 'Bearer good' },
      });
      assertSignatureRejection(res, 'request_signature_required');
      assert.strictEqual(authenticateCalls, 0, 'the gate runs before authenticate');
      assert.strictEqual(seller.calls.createMediaBuy.length, 0);
    });

    it('rejects an unsigned create_media_buy with an unrecognized bearer', async () => {
      const res = await post(started.url, sendMessage('create_media_buy', CREATE_INPUT), {
        headers: { Authorization: 'Bearer junk' },
      });
      assertSignatureRejection(res, 'request_signature_required');
    });
  });

  describe('signed requests', () => {
    it('verifies a signed create_media_buy and surfaces the signer as authInfo', async () => {
      const res = await post(started.url, sendMessage('create_media_buy', CREATE_INPUT), { sign: true });
      assert.strictEqual(res.status, 200, res.text);
      assert.strictEqual(seller.calls.createMediaBuy.length, 1);
      assert.strictEqual(seller.calls.createMediaBuy[0].authInfo?.clientId, 'signing:test-ed25519-2026');
    });

    it('verifies a signed 0.3 message/send', async () => {
      const res = await post(started.url, sendMessage('create_media_buy', CREATE_INPUT, { method: 'message/send' }), {
        sign: true,
        headers: { 'A2A-Version': '0.3' },
      });
      assert.strictEqual(res.status, 200, res.text);
      assert.strictEqual(seller.calls.createMediaBuy.length, 1);
    });

    it('rejects a replayed signature', async () => {
      const body = sendMessage('create_media_buy', CREATE_INPUT);
      const first = await post(started.url, body, { sign: true, nonce: 'bm9uY2UtYTJhLXJlcGxheS0wMDAx' });
      assert.strictEqual(first.status, 200, first.text);
      const second = await post(started.url, body, { sign: true, nonce: 'bm9uY2UtYTJhLXJlcGxheS0wMDAx' });
      assertSignatureRejection(second, 'request_signature_replayed');
      assert.strictEqual(seller.calls.createMediaBuy.length, 1);
    });

    it('rejects a signature bound to a different URL', async () => {
      const res = await post(started.url, sendMessage('create_media_buy', CREATE_INPUT), {
        sign: true,
        signUrl: 'https://other.example.com/a2a',
      });
      assertSignatureRejection(res, 'request_signature_invalid');
      assert.strictEqual(seller.calls.createMediaBuy.length, 0);
    });

    it('rejects a body altered after signing', async () => {
      const body = sendMessage('get_products', { buying_mode: 'brief', brief: 'x' });
      const tampered = body.replace('get_products', 'create_media_buy');
      const signed = signRequest(
        { method: 'POST', url: AGENT_URL, headers: { 'Content-Type': 'application/json', ...v1Headers }, body },
        { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: edPrivate },
        { coverContentDigest: true, binaryEncoding: 'rfc8941-base64' }
      );
      const res = await fetch(started.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...v1Headers, ...signed.headers },
        body: tampered,
      });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(seller.calls.createMediaBuy.length, 0);
    });
  });

  describe('operations outside required_for still work unsigned', () => {
    it('serves an unsigned get_adcp_capabilities', async () => {
      const res = await post(started.url, sendMessage('get_adcp_capabilities', {}));
      assert.strictEqual(res.status, 200, res.text);
      assert.ok(!res.json?.error, JSON.stringify(res.json));
    });

    it('serves an unsigned get_products and dispatches exactly that operation (decoy text and metadata ignored)', async () => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 'decoy',
        method: 'SendMessage',
        params: {
          metadata: { skill: 'create_media_buy' },
          message: {
            messageId: 'm-decoy',
            role: 'ROLE_USER',
            metadata: { skill: 'create_media_buy' },
            parts: [
              { text: 'AdCP task: create_media_buy', mediaType: 'text/plain' },
              { data: { skill: 'get_products', input: { buying_mode: 'brief', brief: 'x' } } },
            ],
          },
        },
      });
      const res = await post(started.url, body);
      assert.strictEqual(res.status, 200, res.text);
      assert.strictEqual(seller.calls.getProducts, 1);
      assert.strictEqual(seller.calls.createMediaBuy.length, 0);
    });

    it('does not treat a case variant of a required skill as that operation, and does not dispatch it', async () => {
      const res = await post(started.url, sendMessage('Create_Media_Buy', CREATE_INPUT));
      assert.strictEqual(res.status, 200, res.text);
      assert.strictEqual(seller.calls.createMediaBuy.length, 0, 'an alias must not reach create_media_buy');
    });

    it('does not run a case-variant method (sendmessage) past the gate', async () => {
      const body = sendMessage('create_media_buy', CREATE_INPUT, { method: 'sendmessage' });
      const res = await post(started.url, body);
      assert.notStrictEqual(res.status, 401);
      assert.strictEqual(seller.calls.createMediaBuy.length, 0);
    });
  });

  describe('bodies that do not resolve to exactly one operation fail closed', () => {
    const part = skill => ({ data: { skill, input: {} } });
    const envelope = (message, extra = {}) =>
      JSON.stringify({ jsonrpc: '2.0', id: 'x', method: 'SendMessage', params: { message }, ...extra });
    const msg = parts => ({ messageId: 'm-x', role: 'ROLE_USER', parts });

    const cases = {
      'two DataParts (first get_products, second create_media_buy)': envelope(
        msg([part('get_products'), part('create_media_buy')])
      ),
      'a DataPart plus a non-invocation DataPart': envelope(msg([part('get_products'), { data: { note: 'x' } }])),
      'a FilePart (url)': envelope(
        msg([part('get_products'), { url: 'https://x.example/f', mediaType: 'text/plain' }])
      ),
      'a raw part': envelope(msg([part('get_products'), { raw: 'AAAA', mediaType: 'application/octet-stream' }])),
      'a Part with both text and data': envelope(
        msg([{ text: 'AdCP task: get_products', data: { skill: 'create_media_buy', input: {} } }])
      ),
      'a text-only message': envelope(msg([{ text: 'please create a media buy' }])),
      'a non-string skill': envelope(msg([{ data: { skill: 7, input: {} } }])),
      'an empty skill': envelope(msg([{ data: { skill: '', input: {} } }])),
      'array data': envelope(msg([{ data: ['create_media_buy', {}] }])),
      'a duplicate skill key': `{"jsonrpc":"2.0","id":"x","method":"SendMessage","params":{"message":{"messageId":"m","role":"ROLE_USER","parts":[{"data":{"skill":"get_products","skill":"create_media_buy","input":{}}}]}}}`,
      'an escaped duplicate skill key': `{"jsonrpc":"2.0","id":"x","method":"SendMessage","params":{"message":{"messageId":"m","role":"ROLE_USER","parts":[{"data":{"skill":"get_products","sk\\u0069ll":"create_media_buy","input":{}}}]}}}`,
      'a duplicate method key': `{"jsonrpc":"2.0","id":"x","method":"tasks/get","method":"SendMessage","params":{"message":{"messageId":"m","role":"ROLE_USER","parts":[{"data":{"skill":"create_media_buy","input":{}}}]}}}`,
      'a case-variant member name': `{"jsonrpc":"2.0","id":"x","method":"SendMessage","params":{"message":{"messageId":"m","role":"ROLE_USER","parts":[{"data":{"skill":"get_products","Skill":"create_media_buy","input":{}}}]}}}`,
      'a JSON-RPC batch': `[${envelope(msg([part('get_products')]))},${envelope(msg([part('create_media_buy')]))}]`,
      'a missing method': JSON.stringify({
        jsonrpc: '2.0',
        id: 'x',
        params: { message: msg([part('create_media_buy')]) },
      }),
      'a 0.3 kind that disagrees with its member': JSON.stringify({
        jsonrpc: '2.0',
        id: 'x',
        method: 'message/send',
        params: {
          message: {
            kind: 'message',
            messageId: 'm',
            role: 'user',
            parts: [{ kind: 'text', data: { skill: 'create_media_buy', input: {} } }],
          },
        },
      }),
      'a body that is not JSON': 'not json',
      'an empty body': '',
    };

    for (const [name, body] of Object.entries(cases)) {
      it(`rejects ${name}, unsigned`, async () => {
        const res = await post(started.url, body);
        assertSignatureRejection(res, 'request_body_malformed');
        assert.strictEqual(seller.calls.createMediaBuy.length, 0);
        assert.strictEqual(seller.calls.getProducts, 0);
      });
    }

    it('rejects an ambiguous body even when it carries a valid signature', async () => {
      const res = await post(started.url, cases['two DataParts (first get_products, second create_media_buy)'], {
        sign: true,
      });
      assertSignatureRejection(res, 'request_body_malformed');
      assert.strictEqual(seller.calls.createMediaBuy.length, 0);
    });

    it('reports request_body_malformed before the signature-header checks (lone Signature header)', async () => {
      const res = await post(started.url, cases['two DataParts (first get_products, second create_media_buy)'], {
        headers: { Signature: 'sig1=:AAAA:' },
      });
      assertSignatureRejection(res, 'request_body_malformed');
    });

    it('rejects an ambiguous body even when the caller holds a valid bearer', async () => {
      await stop(started.srv);
      started = await startAdapter({
        seller,
        adapterOptions: { authenticate: async () => ({ token: 't', clientId: 'buyer_1', scopes: [] }) },
      });
      const res = await post(started.url, cases['two DataParts (first get_products, second create_media_buy)'], {
        headers: { Authorization: 'Bearer good' },
      });
      assertSignatureRejection(res, 'request_body_malformed');
    });
  });

  describe('protocol_methods_required_for', () => {
    it('rejects an unsigned listed JSON-RPC method and leaves unlisted methods alone', async () => {
      await stop(started.srv);
      seller = makeSeller({ signedRequests: { protocol_methods_required_for: ['CancelTask'] } });
      started = await startAdapter({ seller });
      const cancel = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'CancelTask', params: { id: 'nope' } });
      assertSignatureRejection(await post(started.url, cancel), 'request_signature_required');
      const get = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'nope' } });
      const res = await post(started.url, get);
      assert.notStrictEqual(res.status, 401, 'GetTask is not listed');
    });
  });

  describe('body capture', () => {
    it('fails closed when a body parser already consumed the request without recording the bytes', async () => {
      await stop(started.srv);
      started = await startAdapter({ seller, preMount: app => app.use(express.json()) });
      const res = await post(started.url, sendMessage('create_media_buy', CREATE_INPUT), { sign: true });
      assert.strictEqual(res.status, 500);
      assert.strictEqual(res.json?.error, 'raw_body_unavailable');
      assert.strictEqual(seller.calls.createMediaBuy.length, 0);
    });

    it('verifies when the upstream parser records the bytes with adapter.rawBodyVerify', async () => {
      await stop(started.srv);
      const app = express();
      const a2a = createA2AAdapter({
        server: seller.server,
        taskStore: new InMemoryTaskStore(),
        agentCard: { name: 'Seller', description: 'Seller', url: AGENT_URL, version: '1.0.0' },
      });
      app.use(express.json({ verify: a2a.rawBodyVerify }));
      a2a.mount(app, { basePath: '/a2a' });
      const srv = await listen(app);
      started = { srv, url: `http://127.0.0.1:${srv.address().port}/a2a` };
      const signed = await post(started.url, sendMessage('create_media_buy', CREATE_INPUT), { sign: true });
      assert.strictEqual(signed.status, 200, signed.text);
      const unsigned = await post(started.url, sendMessage('create_media_buy', CREATE_INPUT));
      assertSignatureRejection(unsigned, 'request_signature_required');
      assert.strictEqual(seller.calls.createMediaBuy.length, 1);
    });

    it('rejects an oversized body', async () => {
      const big = sendMessage('get_products', { buying_mode: 'brief', brief: 'x'.repeat(200 * 1024) });
      const res = await post(started.url, big);
      assert.strictEqual(res.status, 413);
      assert.strictEqual(seller.calls.getProducts, 0);
    });
  });

  describe('deployment interactions', () => {
    it('verifies a signed request when upstream middleware already set req.auth (e.g. express-jwt)', async () => {
      await stop(started.srv);
      started = await startAdapter({
        seller,
        preMount: app =>
          app.use((req, _res, next) => {
            req.auth = { sub: 'user1' };
            next();
          }),
      });
      const res = await post(started.url, sendMessage('create_media_buy', CREATE_INPUT), { sign: true });
      assert.strictEqual(res.status, 200, res.text);
      assert.strictEqual(seller.calls.createMediaBuy.length, 1);
      assert.strictEqual(seller.calls.createMediaBuy[0].authInfo?.clientId, 'signing:test-ed25519-2026');
    });

    it('rejects a signed request whose authenticate() names a different principal', async () => {
      await stop(started.srv);
      started = await startAdapter({
        seller,
        adapterOptions: { authenticate: async () => ({ token: 't', clientId: 'someone-else', scopes: [] }) },
      });
      const res = await post(started.url, sendMessage('create_media_buy', CREATE_INPUT), { sign: true });
      assert.notStrictEqual(res.status, 401);
      assert.strictEqual(seller.calls.createMediaBuy.length, 0);
    });

    it('rejects a compressed body instead of verifying bytes it cannot read', async () => {
      const res = await post(started.url, sendMessage('get_products', { buying_mode: 'brief', brief: 'x' }), {
        headers: { 'Content-Encoding': 'gzip' },
      });
      assert.strictEqual(res.status, 415);
      assert.strictEqual(seller.calls.getProducts, 0);
    });

    it('leaves non-POST requests to the SDK handler', async () => {
      const res = await fetch(started.url, { method: 'GET' });
      assert.notStrictEqual(res.status, 401);
      assert.strictEqual(seller.calls.createMediaBuy.length, 0);
    });

    it('binds signatures to a signedRequestsUrl override', async () => {
      await stop(started.srv);
      started = await startAdapter({
        seller,
        adapterOptions: { signedRequestsUrl: () => 'https://gateway.example.com/public/a2a' },
      });
      const body = sendMessage('create_media_buy', CREATE_INPUT);
      const wrong = await post(started.url, body, { sign: true });
      assertSignatureRejection(wrong, 'request_signature_invalid');
      const right = await post(started.url, body, { sign: true, signUrl: 'https://gateway.example.com/public/a2a' });
      assert.strictEqual(right.status, 200, right.text);
    });

    it('does not reject a JSON-RPC response body as malformed', async () => {
      const res = await post(started.url, JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
      assert.notStrictEqual(res.status, 401);
    });
  });

  describe('request target and body hygiene', () => {
    /** Raw HTTP/1.1 request, so the request-target can be absolute-form (which fetch cannot send). */
    function rawPost(port, target, headers, body) {
      const net = require('node:net');
      return new Promise((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1', () => {
          const lines = [
            `POST ${target} HTTP/1.1`,
            'Host: seller.example.com',
            `Content-Length: ${Buffer.byteLength(body)}`,
            'Connection: close',
          ];
          for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
          sock.write(`${lines.join('\r\n')}\r\n\r\n${body}`);
        });
        let data = '';
        sock.on('data', chunk => (data += chunk));
        sock.on('end', () => resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1]), text: data }));
        sock.on('error', reject);
      });
    }

    function signedHeaders(body, url) {
      const headers = { 'Content-Type': 'application/json', ...v1Headers };
      const signed = signRequest(
        { method: 'POST', url, headers, body },
        { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: edPrivate },
        { coverContentDigest: true, binaryEncoding: 'rfc8941-base64' }
      );
      return { ...headers, ...signed.headers };
    }

    it('does not let an absolute-form request target choose the signature audience', async () => {
      const port = new URL(started.url).port;
      const body = sendMessage('create_media_buy', CREATE_INPUT);
      // A signature a buyer made for a different seller must not verify here,
      // however the request line is spelled.
      const headers = signedHeaders(body, 'https://other-seller.example.org/a2a');
      const res = await rawPost(port, 'https://other-seller.example.org/a2a', headers, body);
      assert.strictEqual(res.status, 400, res.text);
      assert.strictEqual(seller.calls.createMediaBuy.length, 0);
      const protocolRelative = await rawPost(port, '//other-seller.example.org/a2a', headers, body);
      assert.notStrictEqual(protocolRelative.status, 200);
      assert.strictEqual(seller.calls.createMediaBuy.length, 0);
    });

    it('still serves a correctly signed origin-form request over the same socket path', async () => {
      const port = new URL(started.url).port;
      const body = sendMessage('create_media_buy', CREATE_INPUT);
      const res = await rawPost(port, '/a2a', signedHeaders(body, AGENT_URL), body);
      assert.strictEqual(res.status, 200, res.text);
      assert.strictEqual(seller.calls.createMediaBuy.length, 1);
    });

    it('dispatches the bytes the gate verified, not whatever an upstream parser left in req.body', async () => {
      await stop(started.srv);
      const app = express();
      const a2a = createA2AAdapter({
        server: seller.server,
        taskStore: new InMemoryTaskStore(),
        agentCard: { name: 'Seller', description: 'Seller', url: AGENT_URL, version: '1.0.0' },
      });
      app.use(express.json({ verify: a2a.rawBodyVerify }));
      // Stand-in for any decoder that reads the same bytes differently (a
      // non-UTF-8 `charset`, a case-insensitive key match, ...): by the time the
      // SDK looks, `req.body` says create_media_buy while the bytes say get_products.
      app.use((req, _res, next) => {
        const part = req.body?.params?.message?.parts?.[0]?.data;
        if (part) part.skill = 'create_media_buy';
        next();
      });
      a2a.mount(app, { basePath: '/a2a' });
      const srv = await listen(app);
      started = { srv, url: `http://127.0.0.1:${srv.address().port}/a2a` };
      const res = await post(started.url, sendMessage('get_products', { buying_mode: 'brief', brief: 'x' }));
      assert.strictEqual(res.status, 200, res.text);
      assert.strictEqual(seller.calls.createMediaBuy.length, 0, 'the unsigned buy must not execute');
      assert.strictEqual(seller.calls.getProducts, 1, 'the resolved operation is what runs');
    });

    it('rejects a body that starts with a byte order mark', async () => {
      const res = await post(started.url, `\uFEFF${sendMessage('get_products', { buying_mode: 'brief', brief: 'x' })}`);
      assertSignatureRejection(res, 'request_body_malformed');
    });
  });

  describe('task continuation binding', () => {
    // The signed principal is the task owner: the store scopes tasks by user.
    const owner = { user: { isAuthenticated: true, userName: 'signing:test-ed25519-2026' }, requestedExtensions: [] };

    const seedTask = (taskStore, id, skill, input) =>
      taskStore.save(
        {
          id,
          contextId: `ctx-${id}`,
          status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: new Date().toISOString() },
          artifacts: [],
          history: [
            {
              messageId: `m-seed-${id}`,
              taskId: id,
              contextId: `ctx-${id}`,
              role: Role.ROLE_USER,
              parts: [
                {
                  content: { $case: 'data', value: { skill, input } },
                  metadata: undefined,
                  filename: '',
                  mediaType: 'application/json',
                },
              ],
              metadata: undefined,
              extensions: [],
              referenceTaskIds: [],
            },
          ],
          metadata: undefined,
        },
        owner
      );

    const continuation = (taskId, skill, input) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'c',
        method: 'SendMessage',
        params: {
          message: {
            messageId: `m-c-${taskId}`,
            taskId,
            contextId: `ctx-${taskId}`,
            role: 'ROLE_USER',
            parts: [{ data: { skill, input } }],
          },
        },
      });

    it('rejects a continuation that switches operation before any handler runs', async () => {
      await stop(started.srv);
      const taskStore = new InMemoryTaskStore();
      started = await startAdapter({ seller, adapterOptions: { taskStore } });
      await seedTask(taskStore, 'task-1', 'get_products', { buying_mode: 'brief', brief: 'x' });

      const res = await post(started.url, continuation('task-1', 'create_media_buy', CREATE_INPUT), { sign: true });
      assert.strictEqual(res.status, 200, res.text);
      assert.strictEqual(seller.calls.createMediaBuy.length, 0, 'a continuation must not run a different operation');
      assert.match(res.text, /task continuation must use the operation the task was created for/);
    });

    it('lets a continuation that keeps the operation through', async () => {
      await stop(started.srv);
      const taskStore = new InMemoryTaskStore();
      started = await startAdapter({ seller, adapterOptions: { taskStore } });
      await seedTask(taskStore, 'task-2', 'create_media_buy', CREATE_INPUT);

      const res = await post(started.url, continuation('task-2', 'create_media_buy', CREATE_INPUT), { sign: true });
      assert.strictEqual(res.status, 200, res.text);
      assert.strictEqual(seller.calls.createMediaBuy.length, 1);
    });
  });
});

describe('control: the tests detect the bypass', () => {
  it('lets an unsigned create_media_buy through when no verifier gates the A2A endpoint', async () => {
    // Equivalent to the pre-fix adapter, which never ran the verifier on A2A.
    const seller = makeSeller();
    const started = await startAdapter({ seller, adapterOptions: { preTransport: async () => false } });
    try {
      const res = await post(started.url, sendMessage('create_media_buy', CREATE_INPUT));
      assert.strictEqual(res.status, 200, res.text);
      assert.strictEqual(seller.calls.createMediaBuy.length, 1, 'without a gate the unsigned buy executes');
    } finally {
      await stop(started.srv);
    }
  });
});

describe('createA2AAdapter refuses to advertise unenforced signing', () => {
  const card = { name: 'Seller', description: 'Seller', url: AGENT_URL, version: '1.0.0' };

  it('throws when the server claims signed-requests but no verifier is wired for A2A', () => {
    const seller = makeSeller({ signedRequests: null });
    assert.throws(
      () => createA2AAdapter({ server: seller.server, agentCard: card, taskStore: new InMemoryTaskStore() }),
      /no signature verifier is wired for A2A/
    );
  });

  it('accepts an explicitly supplied preTransport', () => {
    const seller = makeSeller({ signedRequests: null });
    assert.doesNotThrow(() =>
      createA2AAdapter({
        server: seller.server,
        agentCard: card,
        taskStore: new InMemoryTaskStore(),
        preTransport: async () => false,
      })
    );
  });

  it('refuses a relative agentCard.url when a gate is active, unless signedRequestsUrl supplies the URL', () => {
    const seller = makeSeller();
    const relative = { ...card, url: '/a2a' };
    assert.throws(
      () => createA2AAdapter({ server: seller.server, agentCard: relative, taskStore: new InMemoryTaskStore() }),
      /absolute `agentCard.url`/
    );
    assert.doesNotThrow(() =>
      createA2AAdapter({
        server: seller.server,
        agentCard: relative,
        taskStore: new InMemoryTaskStore(),
        signedRequestsUrl: () => AGENT_URL,
      })
    );
  });

  it('accepts an explicit acknowledgement that a gateway enforces signing', () => {
    const seller = makeSeller({ signedRequests: null });
    assert.doesNotThrow(() =>
      createA2AAdapter({
        server: seller.server,
        agentCard: card,
        taskStore: new InMemoryTaskStore(),
        allowUnenforcedSignedRequests: true,
      })
    );
  });

  it('does not touch a seller that does not advertise request signing', async () => {
    const seller = makeSeller({
      signedRequests: null,
      specialisms: [],
      extra: { capabilities: { features: { inlineCreativeManagement: false } } },
    });
    const started = await startAdapter({ seller });
    try {
      const res = await post(started.url, sendMessage('create_media_buy', CREATE_INPUT));
      assert.strictEqual(res.status, 200, res.text);
      assert.strictEqual(seller.calls.createMediaBuy.length, 1);
    } finally {
      await stop(started.srv);
    }
  });
});
