const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createMcpHandler, McpServer } = require('@modelcontextprotocol/server');
const { toNodeHandler } = require('@modelcontextprotocol/node');
const { z } = require('zod');

const previousProbePolicy = process.env.ADCP_ALLOW_INTERNAL_PROBES;
process.env.ADCP_ALLOW_INTERNAL_PROBES = '1';
after(() => {
  if (previousProbePolicy === undefined) delete process.env.ADCP_ALLOW_INTERNAL_PROBES;
  else process.env.ADCP_ALLOW_INTERNAL_PROBES = previousProbePolicy;
});

// Permit loopback in the URL pre-check and network-policy seam. The resolver's
// default callTool and official MCP client still perform real initialization and calls.
const pinModulePath = require.resolve('../../dist/lib/server/pin-and-bind-fetch.js');
const pinModule = require(pinModulePath);
const originalExports = require.cache[pinModulePath].exports;
let helpers;
try {
  require.cache[pinModulePath].exports = {
    ...pinModule,
    createPinAndBindFetch: options =>
      pinModule.createPinAndBindFetch({ ...options, policy: pinModule.LOOPBACK_OK_WEBHOOK_SSRF_POLICY }),
  };
  helpers = require('../../dist/lib/server/targeting-helpers.js');
} finally {
  require.cache[pinModulePath].exports = originalExports;
}

async function serveLists(t, respond) {
  const calls = [];
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'list-resolver-regression', version: '1.0.0' });
    for (const tool of ['get_property_list', 'get_collection_list']) {
      server.registerTool(tool, { inputSchema: z.object({}).passthrough() }, async args => {
        calls.push({ tool, args });
        return respond(tool, args);
      });
    }
    return server;
  });
  const nodeHandler = toNodeHandler(handler);
  const server = http.createServer(nodeHandler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await handler.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, calls };
}

function payloadFor(tool, listId) {
  return {
    status: 'completed',
    list: { list_id: listId, name: 'Inventory selection' },
    ...(tool === 'get_property_list'
      ? { identifiers: [{ type: 'domain', value: 'publisher.example' }] }
      : { collections: [{ publisher_domain: 'publisher.example', collection_id: 'news', name: 'News' }] }),
    pagination: { has_more: false },
    cache_valid_until: '2099-01-01T00:00:00Z',
  };
}

for (const kind of ['property', 'collection']) {
  const resolveList = kind === 'property' ? helpers.resolvePropertyList : helpers.resolveCollectionList;
  const itemsKey = kind === 'property' ? 'identifiers' : 'collections';

  for (const format of ['structuredContent', 'text']) {
    test(`default ${kind} list transport resolves MCP ${format} responses`, async t => {
      const seller = await serveLists(t, (tool, args) => {
        const payload = payloadFor(tool, args.list_id);
        return format === 'structuredContent'
          ? { content: [{ type: 'text', text: 'Inventory list resolved' }], structuredContent: payload }
          : { content: [{ type: 'text', text: JSON.stringify(payload) }] };
      });
      const result = await resolveList({ agent_url: seller.url, list_id: 'list-1' }, { cache: false });
      assert.equal(result.listId, 'list-1');
      assert.deepEqual(result[itemsKey], payloadFor(`get_${kind}_list`, 'list-1')[itemsKey]);
      assert.equal(seller.calls.length, 1);
      assert.equal(seller.calls[0].args.resolve, true);
    });
  }

  test(`${kind} list MCP errors preserve adcp_error and reject success-shaped bodies`, async t => {
    const adcpError = { code: 'PERMISSION_DENIED', message: 'List access denied', recovery: 'terminal' };
    const seller = await serveLists(t, (tool, args) => ({
      isError: true,
      content: [{ type: 'text', text: 'List access denied' }],
      structuredContent: { ...payloadFor(tool, args.list_id), adcp_error: adcpError },
    }));
    await assert.rejects(resolveList({ agent_url: seller.url, list_id: 'list-1' }, { cache: false }), error => {
      assert.equal(error.message, `${kind}_list_invalid_response`);
      assert.deepEqual(error.adcp_error, adcpError);
      assert.deepEqual(error.cause, adcpError);
      return true;
    });
  });

  test(`${kind} list hooks keep supporting bare payloads`, async () => {
    const result = await resolveList(
      { agent_url: 'https://lists.example/mcp', list_id: 'list-1' },
      { cache: false, callTool: async (url, tool, args) => payloadFor(tool, args.list_id) }
    );
    assert.equal(result.listId, 'list-1');
  });

  test(`${kind} list pagination unwraps each page through the default MCP transport`, async t => {
    const seller = await serveLists(t, (tool, args) => {
      const secondPage = args.pagination?.cursor === 'page-2';
      const payload = payloadFor(tool, args.list_id);
      return {
        content: [],
        structuredContent: {
          ...payload,
          pagination: secondPage ? { has_more: false } : { has_more: true, cursor: 'page-2' },
        },
      };
    });
    const result = await resolveList({ agent_url: seller.url, list_id: 'list-1' }, { cache: false });
    assert.equal(result[itemsKey].length, 2);
    assert.deepEqual(
      seller.calls.map(call => call.args.pagination?.cursor),
      [undefined, 'page-2']
    );
  });

  test(`${kind} list isError is terminal even without an adcp_error field`, async t => {
    const seller = await serveLists(t, (tool, args) => ({
      isError: true,
      content: [{ type: 'text', text: 'Tool call failed' }],
      structuredContent: payloadFor(tool, args.list_id),
    }));
    await assert.rejects(
      resolveList({ agent_url: seller.url, list_id: 'list-1' }, { cache: false }),
      new RegExp(`${kind}_list_invalid_response`)
    );
  });

  test(`${kind} list malformed MCP envelopes retain the stable failure message`, async t => {
    const seller = await serveLists(t, () => ({ content: [] }));
    await assert.rejects(
      resolveList({ agent_url: seller.url, list_id: 'list-1' }, { cache: false }),
      new RegExp(`${kind}_list_invalid_response`)
    );
  });

  for (const invalid of ['failed status', 'error payload', 'mismatched list', 'malformed item']) {
    test(`${kind} list rejects ${invalid} before caching`, async t => {
      const seller = await serveLists(t, (tool, args) => {
        const payload = payloadFor(tool, args.list_id);
        if (invalid === 'failed status') payload.status = 'failed';
        if (invalid === 'error payload') payload.errors = [{ code: 'PERMISSION_DENIED', message: 'Denied' }];
        if (invalid === 'mismatched list') payload.list.list_id = 'another-list';
        if (invalid === 'malformed item') payload[itemsKey] = [null];
        return { content: [], structuredContent: payload };
      });
      const cached = [];
      await assert.rejects(
        resolveList(
          { agent_url: seller.url, list_id: 'list-1', auth_token: 'test-list-scope' },
          { cache: { get: () => undefined, set: (...args) => cached.push(args) } }
        ),
        new RegExp(`${kind}_list_invalid_response`)
      );
      assert.equal(cached.length, 0);
    });
  }

  test(`${kind} list validates standard MCP structuredContent in strict mode`, async t => {
    const seller = await serveLists(t, (tool, args) => ({
      content: [{ type: 'text', text: 'Resolved list' }],
      structuredContent: payloadFor(tool, args.list_id),
    }));
    const result = await resolveList(
      { agent_url: seller.url, list_id: 'list-1' },
      { cache: false, strictResponseValidation: true }
    );
    assert.equal(result[itemsKey].length, 1);
  });

  test(`${kind} list strict validation bypasses a permissively warmed cache`, async t => {
    const seller = await serveLists(t, (tool, args) => {
      const payload = payloadFor(tool, args.list_id);
      delete payload.list.name;
      return { content: [], structuredContent: payload };
    });
    const cache = helpers.createResolvedListCache();
    const ref = { agent_url: seller.url, list_id: 'list-1', auth_token: 'test-cache-scope' };
    await resolveList(ref, { cache });
    await resolveList(ref, { cache });
    assert.equal(seller.calls.length, 1, 'normal resolution must populate and reuse the cache');
    await assert.rejects(
      resolveList(ref, { cache, strictResponseValidation: true }),
      new RegExp(`${kind}_list_invalid_response`)
    );
    assert.equal(seller.calls.length, 2, 'strict resolution must fetch and validate the upstream page');
  });
}

for (const malformed of [
  { collection_rid: 1 },
  { distribution_ids: 'invalid' },
  { distribution_ids: [null] },
  { distribution_ids: [{ type: 'roku_channel_id' }] },
  { distribution_ids: [{ type: 1, value: 'news' }] },
]) {
  test(`collection list rejects malformed matcher fields ${JSON.stringify(malformed)}`, async t => {
    const seller = await serveLists(t, (tool, args) => {
      const payload = payloadFor(tool, args.list_id);
      Object.assign(payload.collections[0], malformed);
      return { content: [], structuredContent: payload };
    });
    await assert.rejects(
      helpers.resolveCollectionList({ agent_url: seller.url, list_id: 'list-1' }, { cache: false }),
      /collection_list_invalid_response/
    );
  });
}

test('malformed structuredContent is not replaced with a valid text payload', async t => {
  const seller = await serveLists(t, (tool, args) => ({
    structuredContent: { unexpected: true },
    content: [{ type: 'text', text: JSON.stringify(payloadFor(tool, args.list_id)) }],
  }));
  await assert.rejects(
    helpers.resolvePropertyList({ agent_url: seller.url, list_id: 'list-1' }, { cache: false }),
    /property_list_invalid_response/
  );
});
