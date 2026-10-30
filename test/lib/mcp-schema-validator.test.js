const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { AjvJsonSchemaValidator: LegacyProvider } = require('@modelcontextprotocol/sdk/validation/ajv-provider.js');
const { AjvJsonSchemaValidator: ModernProvider } = require('@modelcontextprotocol/client/validators/ajv');
const {
  CachedJsonSchemaValidator,
  sharedLegacyJsonSchemaValidator,
  sharedModernJsonSchemaValidator,
} = require('../../dist/lib/protocols/mcp-schema-validator.js');
const { connectMCP, connectMCPWithFallback, closeMCPConnections } = require('../../dist/lib/protocols/mcp.js');
const { withMCPConnectionScope } = require('../../dist/lib/protocols/mcp-scope.js');
const { tryListModernMCPTools, tryCallModernMCPTool } = require('../../dist/lib/protocols/mcp-modern.js');

function outputSchema(description, valueType = 'string') {
  return { type: 'object', description, properties: { value: { type: valueType } }, required: ['value'] };
}

for (const Provider of [LegacyProvider, ModernProvider]) {
  const era = Provider === LegacyProvider ? 'legacy' : 'modern';

  test(`${era} validator reuses independently parsed schemas without an $id`, () => {
    let compilations = 0;
    const cache = new CachedJsonSchemaValidator(() => {
      compilations++;
      return new Provider();
    });
    const schema = outputSchema('content reuse');
    const validate = cache.getValidator(schema);
    assert.equal(cache.getValidator(JSON.parse(JSON.stringify(schema))), validate);
    assert.equal(compilations, 1);
    const data = { value: 'ok' };
    assert.deepEqual(validate(data), { valid: true, data, errorMessage: undefined });
    const invalid = validate({ value: 42 });
    assert.equal(invalid.valid, false);
    assert.match(invalid.errorMessage, /string/);
    schema.properties.value.type = 'number';
    const updated = cache.getValidator(schema);
    assert.notEqual(updated, validate);
    assert.equal(updated({ value: 42 }).valid, true);
    assert.equal(compilations, 2);
  });

  test(`${era} validator isolates changed schemas and nested references sharing an $id`, () => {
    const cache = new CachedJsonSchemaValidator(() => new Provider());
    const schema = valueType => ({
      $id: 'https://seller.example/output',
      type: 'object',
      properties: { value: { $ref: '#/$defs/value' } },
      $defs: { value: { $id: 'value', type: valueType } },
      required: ['value'],
    });
    const stringValidator = cache.getValidator(schema('string'));
    const numberValidator = cache.getValidator(schema('number'));
    assert.notEqual(stringValidator, numberValidator);
    assert.equal(stringValidator({ value: 'ok' }).valid, true);
    assert.equal(stringValidator({ value: 1 }).valid, false);
    assert.equal(numberValidator({ value: 1 }).valid, true);
    assert.equal(numberValidator({ value: 'ok' }).valid, false);
    assert.equal(cache.getValidator(schema('string')), stringValidator);
  });

  test(`${era} cached validators cannot be altered through a returned schema object`, () => {
    const cache = new CachedJsonSchemaValidator(() => new Provider());
    // Large enums use an array reference in Ajv's compiled code.
    const schema = { type: 'object', properties: { value: { enum: Array.from({ length: 300 }, (_, i) => i) } } };
    const original = structuredClone(schema);
    const validate = cache.getValidator(schema);
    schema.properties.value.enum.push(500);
    assert.equal(validate({ value: 500 }).valid, false);
    assert.equal(cache.getValidator(original)({ value: 500 }).valid, false);
    assert.equal(cache.getValidator(schema)({ value: 500 }).valid, true);
  });

  test(`${era} validator evicts least recently used compilers while live validators still work`, () => {
    let compilations = 0;
    const cache = new CachedJsonSchemaValidator(() => {
      compilations++;
      return new Provider();
    }, 2);
    const hot = outputSchema('hot');
    const cold = outputSchema('cold', 'number');
    const hotValidator = cache.getValidator(hot);
    const coldValidator = cache.getValidator(cold);
    assert.equal(cache.getValidator(structuredClone(hot)), hotValidator);
    cache.getValidator(outputSchema('new'));
    assert.equal(cache.getValidator(structuredClone(hot)), hotValidator);
    assert.notEqual(cache.getValidator(structuredClone(cold)), coldValidator);
    assert.equal(compilations, 4, 'evicted schemas must compile again in a fresh provider');
    assert.equal(coldValidator({ value: 3 }).valid, true);
    assert.equal(coldValidator({ value: 'invalid' }).valid, false);
  });

  test(`${era} compilation failures do not poison or evict cached validators`, () => {
    let compilations = 0;
    const cache = new CachedJsonSchemaValidator(() => {
      compilations++;
      return new Provider();
    }, 1);
    const schema = outputSchema('valid');
    const validate = cache.getValidator(schema);
    const broken = { $id: 'https://seller.example/broken', $ref: '#/$defs/missing' };
    assert.throws(() => cache.getValidator(broken));
    assert.throws(() => cache.getValidator(structuredClone(broken)));
    assert.equal(compilations, 3, 'failed compilations must be retried');
    assert.equal(cache.getValidator(structuredClone(schema)), validate);
    broken.$defs = { missing: { type: 'string' } };
    assert.equal(cache.getValidator(broken)('fixed').valid, true);
  });
}

test('schema cache capacity must remain bounded', () => {
  for (const capacity of [0, -1, NaN, Infinity, 1.5]) {
    assert.throws(() => new CachedJsonSchemaValidator(() => new LegacyProvider(), capacity), RangeError);
  }
});

test('shared validators preserve each MCP SDK default dialect and format checks', () => {
  const schema = {
    type: 'object',
    properties: {
      values: { type: 'array', prefixItems: [{ type: 'string' }] },
      email: { type: 'string', format: 'email' },
    },
  };
  const legacy = sharedLegacyJsonSchemaValidator.getValidator(schema);
  const modern = sharedModernJsonSchemaValidator.getValidator(schema);
  assert.equal(legacy({ values: [42] }).valid, true, 'v1 keeps its draft-07 default');
  assert.equal(modern({ values: [42] }).valid, false, 'v2 keeps its 2020-12 default');
  for (const validate of [legacy, modern]) {
    assert.equal(validate({ email: 'buyer@example.com' }).valid, true);
    assert.equal(validate({ email: 'invalid' }).valid, false);
  }
  const declaredDraft7 = sharedModernJsonSchemaValidator.getValidator({
    ...schema,
    $schema: 'http://json-schema.org/draft-07/schema#',
  });
  assert.equal(declaredDraft7({ values: [42] }).valid, true);
});

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}/mcp`;
}

test('legacy connections, retries, and direct clients compile identical listed schemas once', async t => {
  const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
  const schema = outputSchema('legacy remote cache regression #3530');
  let compilations = 0;
  const original = LegacyProvider.prototype.getValidator;
  t.mock.method(LegacyProvider.prototype, 'getValidator', function (input) {
    if (input.description === schema.description) compilations++;
    return original.call(this, input);
  });
  let rejectNextInitialize = true;
  const url = await listen(t, async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (message.method === 'initialize' && rejectNextInitialize) {
      rejectNextInitialize = false;
      res.writeHead(503).end();
      return;
    }
    const server = new Server({ name: 'schema-cache', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'echo', inputSchema: { type: 'object' }, outputSchema: schema }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [],
      structuredContent: { value: message.params.arguments.value },
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, message);
    } finally {
      await server.close();
    }
  });

  const logs = [];
  const retryClient = await connectMCPWithFallback(new URL(url), {}, logs, 'schema test', undefined, {
    allowPrivateIp: true,
  });
  try {
    await retryClient.listTools();
    await retryClient.listTools();
    await retryClient.callTool({ name: 'echo', arguments: { value: 'ok' } });
    await assert.rejects(
      retryClient.callTool({ name: 'echo', arguments: { value: 42 } }),
      /output schema.*must be string/i
    );
  } finally {
    await retryClient.close();
  }
  assert.ok(logs.some(entry => entry.message.includes('(retry)')));

  // A different endpoint and the low-level OAuth-capable constructor share the cache.
  const { client } = await connectMCP({ agentUrl: `${url}/second-agent`, allowPrivateIp: true });
  try {
    await client.listTools();
    await client.callTool({ name: 'echo', arguments: { value: 'ok' } });
    await assert.rejects(client.callTool({ name: 'echo', arguments: { value: 42 } }), /output schema.*must be string/i);
  } finally {
    await client.close();
  }
  assert.equal(compilations, 1);
});

test('modern clients reuse schema compilation across listings, connections, and agents', async t => {
  const { createMcpHandler, McpServer } = require('@modelcontextprotocol/server');
  const { toNodeHandler } = require('@modelcontextprotocol/node');
  const schema = outputSchema('modern remote cache regression #3530');
  let compilations = 0;
  const original = ModernProvider.prototype.getValidator;
  t.mock.method(ModernProvider.prototype, 'getValidator', function (input) {
    if (input.description === schema.description) compilations++;
    return original.call(this, input);
  });
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: 'modern-schema-cache', version: '1.0.0' }, { capabilities: { tools: {} } });
      server.server.setRequestHandler('tools/list', () => ({
        tools: [{ name: 'echo', inputSchema: { type: 'object' }, outputSchema: schema }],
      }));
      server.server.setRequestHandler('tools/call', request => ({
        content: [],
        structuredContent: { value: request.params.arguments.value },
      }));
      return server;
    },
    { legacy: 'reject' }
  );
  const url = await listen(t, toNodeHandler(handler));
  t.after(async () => {
    await closeMCPConnections();
    await handler.close();
  });

  for (const endpoint of [url, `${url}/second-agent`, url]) {
    await withMCPConnectionScope(async () => {
      const options = { allowPrivateIp: true };
      for (let i = 0; i < 2; i++) {
        const listing = await tryListModernMCPTools(endpoint, undefined, undefined, options);
        assert.equal(listing.handled, true);
        assert.deepEqual(listing.tools[0].outputSchema, schema);
        const result = await tryCallModernMCPTool(endpoint, 'echo', { value: 'ok' }, undefined, [], undefined, options);
        assert.equal(result.handled, true);
        assert.deepEqual(result.response.structuredContent, { value: 'ok' });
      }
      await assert.rejects(
        tryCallModernMCPTool(endpoint, 'echo', { value: 42 }, undefined, [], undefined, options),
        /output schema.*must be string/i
      );
    });
  }
  assert.equal(compilations, 1);
});
