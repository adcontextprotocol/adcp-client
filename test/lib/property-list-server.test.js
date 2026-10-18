const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { registerPropertyListTool, sendPropertyListChanged } = require('../../dist/lib/server/property-lists');
const { resolvePropertyList, createResolvedListCache } = require('../../dist/lib/server/targeting-helpers');
const { runPropertyListConformance } = require('../../dist/lib/conformance/property-lists');
const { createWebhookEmitter } = require('../../dist/lib/server/webhook-emitter');
const { verifyWebhookSignature } = require('../../dist/lib/signing/webhook-verifier');
const { StaticJwksResolver } = require('../../dist/lib/signing/jwks');
const { InMemoryReplayStore } = require('../../dist/lib/signing/replay');
const { InMemoryRevocationStore } = require('../../dist/lib/signing/revocation');
process.env.NODE_ENV = 'test';

async function setup(t, loadPage) {
  const server = new McpServer({ name: 'property-lists', version: '1.0.0' });
  let loaded = 0;
  registerPropertyListTool(server, {
    verifyToken: async ({ listId, token }) =>
      listId === 'campaign' && token === 'list-secret' ? { tenant: 'buyer' } : null,
    loadPage: async (request, principal) => {
      loaded++;
      assert.equal(principal.tenant, 'buyer');
      return loadPage(request);
    },
  });
  const client = new Client({ name: 'seller', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let token;
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    send(message, { ...options, ...(token ? { authInfo: { token, clientId: 'seller', scopes: [] } } : {}) });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return {
    loaded: () => loaded,
    call: async (args, authToken) => {
      token = authToken;
      return client.callTool({ name: 'get_property_list', arguments: args });
    },
    callTool: async (_url, _name, args, authToken) => {
      token = authToken;
      const response = await client.callTool({ name: 'get_property_list', arguments: args });
      return response.structuredContent;
    },
  };
}

test('registered MCP tool verifies per-list credentials on every page and resolves through seller helper', async t => {
  const calls = [];
  const server = await setup(t, request => {
    calls.push(request);
    return {
      list: { list_id: 'campaign', name: 'Campaign', property_count: 2 },
      identifiers: [
        request.pagination?.cursor
          ? { type: 'roku_store_id', value: '12345' }
          : { type: 'domain', value: 'example.com' },
      ],
      pagination: request.pagination?.cursor ? { has_more: false } : { has_more: true, cursor: 'page-two' },
      cache_valid_until: '2027-01-01T00:00:00Z',
    };
  });
  const reference = { agent_url: 'https://lists.example/mcp', list_id: 'campaign', auth_token: 'list-secret' };
  const resolved = await resolvePropertyList(reference, { callTool: server.callTool, cache: false, pageSize: 1 });
  assert.deepEqual(resolved.identifiers, [
    { type: 'domain', value: 'example.com' },
    { type: 'roku_store_id', value: '12345' },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].pagination.cursor, 'page-two');
  const denied = await server.call({ list_id: 'campaign', auth_token: 'list-secret' }, 'wrong-token');
  assert.equal(denied.isError, true);
  assert.equal(server.loaded(), 2, 'an argument token cannot authorize a read');
  const wrongList = await server.call({ list_id: 'another' }, 'list-secret');
  assert.equal(wrongList.isError, true);
  assert.equal(server.loaded(), 2);
});

test('metadata-only reads echo context, and invalid pages/storage failures cannot leak secrets', async t => {
  let invalid = false;
  const server = await setup(t, request => {
    if (invalid) throw new Error('upstream secret=list-secret');
    assert.equal(request.resolve, false);
    return { list: { list_id: 'campaign', name: 'Campaign' } };
  });
  const result = await server.call({ list_id: 'campaign', resolve: false, context: { trace: 'read' } }, 'list-secret');
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.status, 'completed');
  assert.deepEqual(result.structuredContent.context, { trace: 'read' });
  assert.equal(result.structuredContent.identifiers, undefined);
  invalid = true;
  const failed = await server.call({ list_id: 'campaign' }, 'list-secret');
  assert.equal(failed.isError, true);
  assert.equal(JSON.stringify(failed).includes('list-secret'), false);
});

test('resolving loader omissions fail, storage-only fields stay private, and errors echo context', async t => {
  let omitIdentifiers = true;
  const server = await setup(t, () => ({
    list: { list_id: 'campaign', name: 'Campaign', auth_token: 'storage-secret' },
    auth_token: 'storage-secret',
    ...(omitIdentifiers ? {} : { identifiers: [{ type: 'domain', value: 'example.com', secret: 'storage-secret' }] }),
  }));
  const missing = await server.call({ list_id: 'campaign', context: { trace: 'failure' } }, 'list-secret');
  assert.equal(missing.isError, true);
  assert.deepEqual(missing.structuredContent.context, { trace: 'failure' });
  omitIdentifiers = false;
  const valid = await server.call({ list_id: 'campaign' }, 'list-secret');
  assert.equal(valid.isError, undefined);
  assert.equal(JSON.stringify(valid).includes('storage-secret'), false);
  const denied = await server.call({ list_id: 'campaign', context: { trace: 'denied' } });
  assert.deepEqual(denied.structuredContent.context, { trace: 'denied' });
});

test('list authorization accepts matching HTTP bearer/header tokens and rejects conflicting credentials', async () => {
  let handler;
  let reads = 0;
  registerPropertyListTool(
    {
      registerTool: (_name, _schema, callback) => {
        handler = callback;
      },
    },
    {
      verifyToken: async ({ token }) => (token === 'list-token' ? true : null),
      loadPage: async () => {
        reads++;
        return { list: { list_id: 'campaign', name: 'Campaign' }, identifiers: [] };
      },
    }
  );
  const request = { list_id: 'campaign' };
  const call = headers => handler(request, { requestInfo: { headers } });
  assert.equal((await call({ Authorization: 'Bearer list-token', 'x-adcp-auth': 'list-token' })).isError, undefined);
  assert.equal((await call({ Authorization: 'Bearer list-token', 'x-adcp-auth': 'other-token' })).isError, true);
  assert.equal((await call({ Authorization: 'Basic list-token', 'x-adcp-auth': 'list-token' })).isError, true);
  assert.equal(
    (await call({ Authorization: ['Bearer list-token', 'Bearer other'], 'x-adcp-auth': 'list-token' })).isError,
    true
  );
  assert.equal(reads, 1);
});

test('certification bypasses caches and fails broken references, invalid shapes, and cursor cycles', async () => {
  const reference = { agent_url: 'https://lists.example/mcp', list_id: 'campaign', auth_token: 'never-publish-this' };
  const cache = createResolvedListCache();
  const valid = {
    status: 'completed',
    list: { list_id: 'campaign', name: 'Campaign' },
    identifiers: [],
    cache_valid_until: '2027-01-01T00:00:00Z',
  };
  await resolvePropertyList(reference, { cache, callTool: async () => valid });
  await assert.rejects(
    resolvePropertyList(reference, {
      cache: false,
      callTool: async () => ({
        ...valid,
        status: 'failed',
        errors: [{ code: 'PERMISSION_DENIED', message: 'denied' }],
      }),
    }),
    /property_list_invalid_response/
  );
  await assert.rejects(
    resolvePropertyList(reference, { cache: false, callTool: async () => ({ status: 'completed', list: valid.list }) }),
    /property_list_invalid_response/
  );
  for (const callTool of [
    async () => {
      throw new Error('Tool get_property_list not found; never-publish-this');
    },
    async () => ({ list: { list_id: 'campaign' } }),
    async () => ({ ...valid, identifiers: ['garbage'] }),
    async () => ({ ...valid, list: { list_id: 'other', name: 'Other' } }),
    async () => ({ ...valid, status: 'failed', errors: [{ code: 'PERMISSION_DENIED', message: 'denied' }] }),
    async () => ({ ...valid, pagination: { has_more: true, cursor: 'repeated' } }),
  ]) {
    const report = await runPropertyListConformance([reference], { cache, callTool });
    assert.equal(report.totalFailures, 1);
    assert.equal(JSON.stringify(report).includes(reference.auth_token), false);
  }
  assert.equal((await runPropertyListConformance([reference], { callTool: async () => valid })).totalFailures, 0);
  assert.equal(
    (
      await runPropertyListConformance([reference], {
        pageSize: 1,
        callTool: async () => ({
          ...valid,
          identifiers: [
            { type: 'domain', value: 'one.example' },
            { type: 'domain', value: 'two.example' },
          ],
        }),
      })
    ).totalFailures,
    1
  );
});

test('completed list pages may contain non-fatal warnings', async () => {
  const reference = { agent_url: 'https://lists.example/mcp', list_id: 'campaign' };
  const page = {
    status: 'completed',
    list: { list_id: 'campaign', name: 'Campaign' },
    identifiers: [{ type: 'domain', value: 'example.com' }],
    errors: [{ code: 'UNSUPPORTED_FEATURE', message: 'Optional feature data is unavailable.', severity: 'warning' }],
  };
  const resolved = await resolvePropertyList(reference, { cache: false, callTool: async () => page });
  assert.equal(resolved.identifiers.length, 1);
  assert.equal((await runPropertyListConformance([reference], { callTool: async () => page })).totalFailures, 0);
});

test('main conformance reports include reference failures without exposing reference credentials', async () => {
  const { runConformance } = require('../../dist/lib/conformance');
  const report = await runConformance('https://buyer.example/mcp', {
    tools: [],
    propertyListReferences: [{ agent_url: 'file:///tmp/list', list_id: 'private-list', auth_token: 'private-token' }],
  });
  assert.equal(report.totalFailures, 1);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].tool, 'get_property_list');
  assert.equal(JSON.stringify(report).includes('private-token'), false);
});

test('list-change sender signs schema-conformant, byte-identical retries with stable idempotency', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyid = 'property-list-events';
  const signerKey = {
    keyid,
    alg: 'ed25519',
    privateKey: {
      ...privateKey.export({ format: 'jwk' }),
      kid: keyid,
      alg: 'ed25519',
      adcp_use: 'request-signing',
      key_ops: ['sign'],
    },
  };
  const publicJwk = {
    ...publicKey.export({ format: 'jwk' }),
    kid: keyid,
    alg: 'ed25519',
    adcp_use: 'request-signing',
    key_ops: ['verify'],
  };
  const calls = [];
  const emitter = createWebhookEmitter({
    signerKey,
    sleep: async () => {},
    fetch: async (url, init) => {
      calls.push({ url, ...init });
      return { status: calls.length === 1 ? 503 : 204, headers: new Headers() };
    },
  });
  const result = await sendPropertyListChanged(emitter, {
    url: 'https://seller.example/list-events',
    delivery_id: 'campaign.change.1',
    notification: {
      list_id: 'campaign',
      resolved_at: '2026-10-17T17:00:00Z',
      change_summary: { properties_added: 1, properties_removed: undefined, total_properties: 2 },
    },
  });
  assert.equal(result.delivered, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, calls[1].body);
  const body = JSON.parse(calls[0].body);
  assert.equal(body.signature, 'rfc9421');
  assert.equal(body.event, 'property_list_changed');
  assert.equal(body.idempotency_key, result.idempotency_key);
  const verified = await verifyWebhookSignature(
    { method: 'POST', url: calls[1].url, headers: calls[1].headers, body: calls[1].body },
    {
      jwks: new StaticJwksResolver([publicJwk]),
      replayStore: new InMemoryReplayStore(),
      revocationStore: new InMemoryRevocationStore(),
    }
  );
  assert.equal(verified.status, 'verified');
  await assert.rejects(
    () =>
      sendPropertyListChanged(emitter, {
        url: 'https://seller.example',
        delivery_id: 'invalid',
        notification: { list_id: 'campaign', resolved_at: '2026' },
      }),
    /timestamps/
  );
});
