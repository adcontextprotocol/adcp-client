import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/sdk/validation/ajv-provider.js');
const { getToolSchemaDocument } = require('../../../dist/lib/validation/schema-loader.js');
const { connectMCP } = require('../../../dist/lib/protocols/mcp.js');
const { withResponseSizeLimit } = require('../../../dist/lib/protocols/responseSizeLimit.js');

export async function run(context) {
  // The real discovery fixture exceeds the SDK's default 4 MiB response cap.
  return withResponseSizeLimit(32 * 1024 ** 2, () => runDiscovery(context));
}

async function runDiscovery({ mode, options, measurePhase }) {
  const version = options.adcpVersion ?? '3.2.7';
  const toolNames = options.tools ?? ['get_products', 'list_creative_formats'];
  const connections = options.connections ?? 3;
  const listings = options.listings ?? 2;
  const source = [];
  const tools = toolNames.map(name => {
    const response = getToolSchemaDocument(name, 'sync', version);
    const request = getToolSchemaDocument(name, 'request', version);
    assert.ok(response && request, `Missing real bundled schemas for ${name}; run npm run build:lib`);
    const outputSchema = structuredClone(response.schema);
    // Reproduce sellers that publish self-contained AdCP schemas without $id.
    // All validation constraints remain the protocol-authored ones.
    delete outputSchema.$id;
    const serialized = JSON.stringify(outputSchema);
    source.push({
      name,
      adcpVersion: response.resolvedVersion,
      bytes: Buffer.byteLength(serialized),
      sha256: createHash('sha256').update(serialized).digest('hex'),
    });
    return { name, inputSchema: request.schema, outputSchema };
  });
  let compilations = 0;
  const original = AjvJsonSchemaValidator.prototype.getValidator;
  AjvJsonSchemaValidator.prototype.getValidator = function (schema) {
    compilations++;
    return original.call(this, schema);
  };

  const server = createServer(async (req, res) => {
    const mcp = new Server({ name: 'real-adcp-schema-performance', version: '1.0.0' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500).end(String(error));
      else res.destroy(error);
    } finally {
      await mcp.close();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
  const open = async index => {
    const url = `${endpoint}/agent-${index}`;
    if (mode === 'cached') return (await connectMCP({ agentUrl: url, allowPrivateIp: true })).client;
    // Exactly the old SDK construction: a new official default provider per
    // client, without the shared jsonSchemaValidator option.
    const client = new Client({ name: 'uncached-adcp-baseline', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return client;
  };
  const samples = [];
  const list = async client => {
    const result = await client.listTools();
    assert.equal(result.tools.length, tools.length);
    samples.push({ listing: samples.length + 1, ...process.memoryUsage() });
  };
  let client;
  try {
    const cold = await measurePhase('cold discovery', async () => {
      client = await open(0);
      await list(client);
    });
    const coldCompilations = compilations;
    const warm = await measurePhase('repeated discovery and new connections', async () => {
      for (let connection = 0; connection < connections; connection++) {
        if (connection > 0) client = await open(connection);
        try {
          for (let listing = connection === 0 ? 1 : 0; listing < listings; listing++) await list(client);
        } finally {
          await client.close();
          client = undefined;
        }
      }
    });
    const warmListings = connections * listings - 1;
    return {
      source,
      workload: { connections, listings, tools: toolNames },
      phases: [cold, warm],
      samples,
      metrics: {
        coldCompilations,
        coldCompilationMismatch: Math.abs(coldCompilations - new Set(source.map(tool => tool.sha256)).size),
        warmCompilations: compilations - coldCompilations,
        warmCpuMsPerListing: warm.cpuMs / warmListings,
        warmEventLoopMaxMs: warm.eventLoopMaxMs,
        retainedHeapGrowthBytes: warm.afterGc.heapUsed - cold.afterGc.heapUsed,
        peakRssBytes: warm.afterGc.peakRssBytes,
      },
      maximums: {
        coldCompilationMismatch: 0,
        warmCompilations: 0,
        warmCpuMsPerListing: Math.max(100, cold.cpuMs * 0.5),
        warmEventLoopMaxMs: 1500,
        retainedHeapGrowthBytes: 64 * 1024 ** 2,
        peakRssBytes: 512 * 1024 ** 2,
      },
    };
  } finally {
    await client?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    AjvJsonSchemaValidator.prototype.getValidator = original;
  }
}
