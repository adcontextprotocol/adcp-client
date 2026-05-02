'use strict';

const { describe, it, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Require from the built output so the test verifies the compiled module too.
const { createTranslationMap, createUpstreamHttpClient } = require('../dist/lib/server/index.js');

// ---------------------------------------------------------------------------
// createTranslationMap
// ---------------------------------------------------------------------------

describe('createTranslationMap', () => {
  const channelMap = createTranslationMap({
    olv: 'video',
    ctv: 'ctv',
    display: 'display',
    streaming_audio: 'audio',
  });

  it('toUpstream returns the B-side value', () => {
    assert.equal(channelMap.toUpstream('olv'), 'video');
    assert.equal(channelMap.toUpstream('ctv'), 'ctv');
  });

  it('toAdcp returns the A-side value', () => {
    assert.equal(channelMap.toAdcp('video'), 'olv');
    assert.equal(channelMap.toAdcp('audio'), 'streaming_audio');
  });

  it('toUpstream returns undefined for unknown key', () => {
    assert.equal(channelMap.toUpstream('unknown'), undefined);
  });

  it('toAdcp returns undefined for unknown key', () => {
    assert.equal(channelMap.toAdcp('unknown_upstream'), undefined);
  });

  it('hasAdcp identifies known A-side keys', () => {
    assert.ok(channelMap.hasAdcp('olv'));
    assert.ok(!channelMap.hasAdcp('video'));
    assert.ok(!channelMap.hasAdcp('missing'));
  });

  it('hasUpstream identifies known B-side keys', () => {
    assert.ok(channelMap.hasUpstream('video'));
    assert.ok(!channelMap.hasUpstream('olv'));
    assert.ok(!channelMap.hasUpstream('missing'));
  });
});

// ---------------------------------------------------------------------------
// createUpstreamHttpClient
// ---------------------------------------------------------------------------

// Minimal fetch mock — replaces global fetch for test duration.
let mockResponses = [];
let capturedRequests = [];

function mockFetch(url, init) {
  capturedRequests.push({ url, init });
  const next = mockResponses.shift();
  if (!next) throw new Error('No mock response queued');
  return Promise.resolve({
    status: next.status,
    ok: next.status >= 200 && next.status < 300,
    text: () => Promise.resolve(next.body ?? ''),
  });
}

describe('createUpstreamHttpClient', () => {
  before(() => {
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    mockResponses = [];
    capturedRequests = [];
  });

  it('GET injects static_bearer Authorization header', async () => {
    mockResponses.push({ status: 200, body: JSON.stringify({ ok: true }) });
    const client = createUpstreamHttpClient({
      baseUrl: 'https://api.example.com',
      auth: { kind: 'static_bearer', token: 'tok_123' },
    });
    const result = await client.get('/items');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true });
    assert.equal(capturedRequests[0].init.headers['Authorization'], 'Bearer tok_123');
  });

  it('GET injects dynamic_bearer Authorization header', async () => {
    mockResponses.push({ status: 200, body: JSON.stringify([]) });
    const client = createUpstreamHttpClient({
      baseUrl: 'https://api.example.com',
      auth: { kind: 'dynamic_bearer', getToken: async () => 'fresh_token' },
    });
    await client.get('/items');
    assert.equal(capturedRequests[0].init.headers['Authorization'], 'Bearer fresh_token');
  });

  it('GET injects api_key header', async () => {
    mockResponses.push({ status: 200, body: JSON.stringify({}) });
    const client = createUpstreamHttpClient({
      baseUrl: 'https://api.example.com',
      auth: { kind: 'api_key', header: 'X-Api-Key', key: 'secret_key' },
    });
    await client.get('/items');
    assert.equal(capturedRequests[0].init.headers['X-Api-Key'], 'secret_key');
  });

  it('GET with kind:none sends no auth header', async () => {
    mockResponses.push({ status: 200, body: JSON.stringify({}) });
    const client = createUpstreamHttpClient({
      baseUrl: 'https://api.example.com',
      auth: { kind: 'none' },
    });
    await client.get('/items');
    assert.ok(!capturedRequests[0].init.headers['Authorization']);
  });

  it('GET serializes query params', async () => {
    mockResponses.push({ status: 200, body: JSON.stringify([]) });
    const client = createUpstreamHttpClient({
      baseUrl: 'https://api.example.com',
      auth: { kind: 'none' },
    });
    await client.get('/items', { limit: 10, q: 'hello world' });
    assert.ok(capturedRequests[0].url.includes('limit=10'));
    assert.ok(capturedRequests[0].url.includes('q=hello%20world'));
  });

  it('GET skips undefined query params', async () => {
    mockResponses.push({ status: 200, body: JSON.stringify([]) });
    const client = createUpstreamHttpClient({
      baseUrl: 'https://api.example.com',
      auth: { kind: 'none' },
    });
    await client.get('/items', { a: 1, b: undefined });
    assert.ok(!capturedRequests[0].url.includes('b='));
    assert.ok(capturedRequests[0].url.includes('a=1'));
  });

  it('GET 404 returns body: null without throwing', async () => {
    mockResponses.push({ status: 404, body: 'not found' });
    const client = createUpstreamHttpClient({
      baseUrl: 'https://api.example.com',
      auth: { kind: 'none' },
    });
    const result = await client.get('/items/missing');
    assert.equal(result.status, 404);
    assert.equal(result.body, null);
  });

  it('GET non-2xx throws', async () => {
    mockResponses.push({ status: 500, body: 'internal error' });
    const client = createUpstreamHttpClient({
      baseUrl: 'https://api.example.com',
      auth: { kind: 'none' },
    });
    await assert.rejects(() => client.get('/items'), /500/);
  });

  it('GET 204 empty body returns body: null', async () => {
    mockResponses.push({ status: 204, body: '' });
    const client = createUpstreamHttpClient({
      baseUrl: 'https://api.example.com',
      auth: { kind: 'none' },
    });
    const result = await client.get('/items');
    assert.equal(result.status, 204);
    assert.equal(result.body, null);
  });

  it('POST sends JSON body and defaultHeaders', async () => {
    mockResponses.push({ status: 201, body: JSON.stringify({ id: 'x' }) });
    const client = createUpstreamHttpClient({
      baseUrl: 'https://api.example.com',
      auth: { kind: 'none' },
      defaultHeaders: { 'X-Tenant': 'tenant_1' },
    });
    const result = await client.post('/items', { name: 'test' });
    assert.equal(result.status, 201);
    assert.deepEqual(result.body, { id: 'x' });
    assert.equal(capturedRequests[0].init.method, 'POST');
    assert.equal(capturedRequests[0].init.body, JSON.stringify({ name: 'test' }));
    assert.equal(capturedRequests[0].init.headers['X-Tenant'], 'tenant_1');
  });

  it('DELETE sends correct method', async () => {
    mockResponses.push({ status: 204, body: '' });
    const client = createUpstreamHttpClient({
      baseUrl: 'https://api.example.com',
      auth: { kind: 'none' },
    });
    await client.delete('/items/1');
    assert.equal(capturedRequests[0].init.method, 'DELETE');
  });

  it('PUT sends JSON body and correct method', async () => {
    mockResponses.push({ status: 200, body: JSON.stringify({ id: 'x', name: 'updated' }) });
    const client = createUpstreamHttpClient({
      baseUrl: 'https://api.example.com',
      auth: { kind: 'none' },
    });
    const result = await client.put('/items/x', { name: 'updated' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { id: 'x', name: 'updated' });
    assert.equal(capturedRequests[0].init.method, 'PUT');
    assert.equal(capturedRequests[0].init.body, JSON.stringify({ name: 'updated' }));
  });

  it('GET non-2xx empty body throws', async () => {
    mockResponses.push({ status: 500, body: '' });
    const client = createUpstreamHttpClient({
      baseUrl: 'https://api.example.com',
      auth: { kind: 'none' },
    });
    await assert.rejects(() => client.get('/items'), /500/);
  });

  it('GET does not send Content-Type header', async () => {
    mockResponses.push({ status: 200, body: JSON.stringify([]) });
    const client = createUpstreamHttpClient({
      baseUrl: 'https://api.example.com',
      auth: { kind: 'none' },
    });
    await client.get('/items');
    assert.ok(!capturedRequests[0].init.headers['Content-Type']);
  });

  it('dynamic_bearer.getToken receives authContext from per-call options', async () => {
    mockResponses.push({ status: 200, body: JSON.stringify({}) });
    let captured;
    const client = createUpstreamHttpClient({
      baseUrl: 'https://api.example.com',
      auth: {
        kind: 'dynamic_bearer',
        getToken: async ctx => {
          captured = ctx;
          return 'tok_for_acme';
        },
      },
    });
    await client.get('/items', undefined, undefined, { authContext: { operatorId: 'acme' } });
    assert.deepEqual(captured, { operatorId: 'acme' });
    assert.equal(capturedRequests[0].init.headers['Authorization'], 'Bearer tok_for_acme');
  });

  it('dynamic_bearer.getToken receives undefined ctx when no authContext passed', async () => {
    mockResponses.push({ status: 200, body: JSON.stringify({}) });
    let captured = 'sentinel';
    const client = createUpstreamHttpClient({
      baseUrl: 'https://api.example.com',
      auth: {
        kind: 'dynamic_bearer',
        getToken: async ctx => {
          captured = ctx;
          return 'master_key';
        },
      },
    });
    await client.get('/items');
    assert.equal(captured, undefined);
    assert.equal(capturedRequests[0].init.headers['Authorization'], 'Bearer master_key');
  });

  it('per-call authContext routes to per-operator credential', async () => {
    mockResponses.push({ status: 200, body: JSON.stringify({}) });
    mockResponses.push({ status: 200, body: JSON.stringify({}) });
    const keys = { acme: 'tok_acme', globex: 'tok_globex' };
    const client = createUpstreamHttpClient({
      baseUrl: 'https://api.example.com',
      auth: {
        kind: 'dynamic_bearer',
        getToken: async ctx => keys[ctx?.operatorId] ?? 'master',
      },
    });
    await client.get('/items', undefined, undefined, { authContext: { operatorId: 'acme' } });
    await client.post('/items', { x: 1 }, undefined, { authContext: { operatorId: 'globex' } });
    assert.equal(capturedRequests[0].init.headers['Authorization'], 'Bearer tok_acme');
    assert.equal(capturedRequests[1].init.headers['Authorization'], 'Bearer tok_globex');
  });

  it('passthrough: authContext.principal becomes the upstream Bearer', async () => {
    mockResponses.push({ status: 200, body: JSON.stringify({}) });
    const client = createUpstreamHttpClient({
      baseUrl: 'https://api.example.com',
      auth: {
        kind: 'dynamic_bearer',
        getToken: async ctx => ctx?.principal ?? 'fallback',
      },
    });
    await client.get('/items', undefined, undefined, { authContext: { principal: 'caller_token_xyz' } });
    assert.equal(capturedRequests[0].init.headers['Authorization'], 'Bearer caller_token_xyz');
  });
});
