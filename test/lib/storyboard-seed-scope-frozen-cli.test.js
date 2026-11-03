process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const compiledRoot = process.env.ADCP_TEST_COMPILED_ROOT || path.resolve(__dirname, '../../dist');
const { createAdcpServer } = require(path.join(compiledRoot, 'lib/server/create-adcp-server.js'));
const { runStoryboard, parseStoryboard, createComplyController } = require(
  path.join(compiledRoot, 'lib/testing/index.js')
);

const account = {
  brand: { domain: 'acmeoutdoor.example' },
  operator: 'pinnacle-agency.example',
  sandbox: true,
};

async function seller(t) {
  const requests = [];
  const seeds = [];
  const errors = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    if (body?.method === 'tools/call') requests.push(structuredClone(body.params));
    const agent = createAdcpServer({
      name: 'Frozen storyboard scope regression',
      version: '1.0.0',
      adcpVersion: '3.0.25',
      defaultAdcpVersion: '3.0.25',
      // A catalog/creative-style seller need not implement create_media_buy.
      // Its unsupported write phases must remain skips after valid preflight.
      mediaBuy: { getProducts: async () => ({ products: [] }) },
    });
    createComplyController({
      // This loopback fixture is a server-controlled sandbox deployment.
      sandboxGate: () => true,
      seed: {
        product: async (params, ctx) => seeds.push({ scenario: 'seed_product', params, account: ctx.input.account }),
        pricing_option: async (params, ctx) =>
          seeds.push({ scenario: 'seed_pricing_option', params, account: ctx.input.account }),
      },
    }).register(agent);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await agent.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      errors.push(error);
      if (!response.headersSent) response.writeHead(500).end();
    } finally {
      await agent.close();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, requests, seeds, errors };
}

function assertFrozenResult(result) {
  assert.equal(result.storyboard_id, 'idempotency');
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  assert.equal(result.failed_count, 0);
  assert.equal(result.passed_count, 3, 'two actual fixture seeds and capability discovery must pass');
  assert.ok(result.skipped_count >= 8, 'unsupported seller writes and the opt-in rate-limit probe remain skips');
  const capability = result.phases.flatMap(phase => phase.steps).find(step => step.step_id === 'get_capabilities');
  const schema = capability.validations.find(validation => validation.check === 'response_schema');
  assert.equal(schema.passed, true);
  assert.match(schema.schema_id, /\/schemas\/3\.0\.25\//);
}

test('the full frozen 3.0 corpus preflights through official MCP with a run brand and the public CLI', async t => {
  const sourcePath = path.resolve(compiledRoot, '../compliance/cache/3.0.25/universal/idempotency.yaml');
  const storyboard = parseStoryboard(readFileSync(sourcePath, 'utf8'));
  const host = await seller(t);
  const result = await runStoryboard(host.url, storyboard, {
    protocol: 'mcp',
    allow_http: true,
    adcpVersion: '3.0.25',
    sandbox: true,
    brand: account.brand,
  });
  assertFrozenResult(result);
  assert.equal(host.seeds.length, 2);
  for (const seed of host.seeds) assert.deepEqual(seed.account, account);
  assert.equal(
    host.requests.some(request => request.name === 'create_media_buy'),
    false
  );

  // The CLI does not expose options.brand. This is a real CLI compatibility
  // control for the same untouched published corpus, not a claim that an
  // unsupported --brand flag reproduces the programmatic regression above.
  const start = host.seeds.length;
  const cli = path.resolve(compiledRoot, '../bin/adcp.js');
  const output = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        cli,
        'storyboard',
        'run',
        host.url,
        '--file',
        sourcePath,
        '--protocol',
        'mcp',
        '--allow-http',
        '--sandbox',
        '--compliance-version',
        '3.0.25',
        '--json',
      ],
      {
        env: { ...process.env, ADCP_SKIP_VERSION_CHECK: '1' },
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(output.code, 0, output.stderr + output.stdout);
  const parsed = JSON.parse(output.stdout);
  const results = Array.isArray(parsed) ? parsed : (parsed.results ?? [parsed]);
  assertFrozenResult(results.find(item => item.storyboard_id === 'idempotency'));
  assert.equal(host.seeds.length - start, 2);
  for (const seed of host.seeds.slice(start)) assert.deepEqual(seed.account, account);
  assert.deepEqual(host.errors, []);
  assert.equal(
    host.requests.some(request => request.name === 'create_media_buy'),
    false
  );
});
