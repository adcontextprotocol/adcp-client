const { describe, it } = require('node:test');
const assert = require('node:assert');

const { mcpToolNameResolver } = require('../../dist/lib/server/index.js');

function makeReq(rawBody) {
  return {
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json' },
    rawBody,
  };
}

describe('mcpToolNameResolver', () => {
  it('returns the tool name for a tools/call JSON-RPC request', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'create_media_buy', arguments: { plan_id: 'p_1' } },
    });
    assert.strictEqual(mcpToolNameResolver(makeReq(body)), 'create_media_buy');
  });

  it('returns undefined for non-tools/call methods', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.strictEqual(mcpToolNameResolver(makeReq(body)), undefined);
  });

  it('returns undefined when params.name is missing', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} });
    assert.strictEqual(mcpToolNameResolver(makeReq(body)), undefined);
  });

  it('returns undefined when params.name is not a string', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 42 } });
    assert.strictEqual(mcpToolNameResolver(makeReq(body)), undefined);
  });

  it('returns undefined for malformed JSON', () => {
    assert.strictEqual(mcpToolNameResolver(makeReq('{ not json')), undefined);
  });

  it('returns undefined when rawBody is missing or empty', () => {
    assert.strictEqual(mcpToolNameResolver(makeReq(undefined)), undefined);
    assert.strictEqual(mcpToolNameResolver(makeReq('')), undefined);
  });

  it('returns undefined when params is absent on a tools/call request', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call' });
    assert.strictEqual(mcpToolNameResolver(makeReq(body)), undefined);
  });
});
