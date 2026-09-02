const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ADCP_MIRRORED_STRUCTURED_CONTENT_META_KEY,
  applyStructuredContentTextFallback,
} = require('../dist/lib/server/structured-content-fallback');

function canonicalResponse() {
  return {
    content: [{ type: 'text', text: 'Human summary' }],
    structuredContent: { products: [{ product_id: 'p1' }] },
  };
}

function mirroredBlocks(response) {
  return response.content.filter(block => block._meta?.[ADCP_MIRRORED_STRUCTURED_CONTENT_META_KEY] === true);
}

test('named fallback policies mark a cloned MCP response and keep A2A clean', () => {
  const canonical = canonicalResponse();
  const always = applyStructuredContentTextFallback(canonical, 'always', { transport: 'mcp' });
  const auto = applyStructuredContentTextFallback(canonical, 'auto', { transport: 'mcp' });

  assert.notStrictEqual(always, canonical);
  assert.deepStrictEqual(canonical.content, [{ type: 'text', text: 'Human summary' }]);
  assert.strictEqual(mirroredBlocks(always).length, 1);
  assert.strictEqual(mirroredBlocks(auto).length, 1);
  assert.strictEqual(applyStructuredContentTextFallback(canonical, 'never', { transport: 'mcp' }), canonical);
  assert.strictEqual(applyStructuredContentTextFallback(canonical, 'always', { transport: 'a2a' }), canonical);
});

test('unknown clients fail safe without consulting a deployment predicate', () => {
  const canonical = canonicalResponse();
  let calls = 0;
  const result = applyStructuredContentTextFallback(
    canonical,
    () => {
      calls += 1;
      return false;
    },
    { transport: 'direct' }
  );

  assert.strictEqual(calls, 0);
  assert.strictEqual(mirroredBlocks(result).length, 1);
});

test('known clients and A2A expose the extensible predicate context', () => {
  const canonical = canonicalResponse();
  const contexts = [];
  const predicate = context => {
    contexts.push(context);
    return false;
  };
  const clientInfo = { name: 'capable-host', version: '1.0.0' };

  assert.strictEqual(
    applyStructuredContentTextFallback(canonical, predicate, {
      transport: 'mcp',
      clientInfo,
      clientCapabilities: { experimental: {} },
    }),
    canonical
  );
  assert.strictEqual(applyStructuredContentTextFallback(canonical, predicate, { transport: 'a2a' }), canonical);
  assert.deepStrictEqual(
    contexts.map(context => context.transport),
    ['mcp', 'a2a']
  );
});

test('exact-string dedup and predicate failures preserve a single legible result', () => {
  const canonical = canonicalResponse();
  const serialized = JSON.stringify(canonical.structuredContent);
  const adopterMirrored = {
    ...canonical,
    content: [...canonical.content, { type: 'text', text: serialized }],
  };
  const client = {
    transport: 'mcp',
    clientInfo: { name: 'known-host', version: '1.0.0' },
  };

  assert.strictEqual(applyStructuredContentTextFallback(adopterMirrored, 'always', client), adopterMirrored);
  const failedPredicate = applyStructuredContentTextFallback(
    canonical,
    () => {
      throw new Error('deployment predicate failed');
    },
    client
  );
  assert.strictEqual(mirroredBlocks(failedPredicate).length, 1);
});
