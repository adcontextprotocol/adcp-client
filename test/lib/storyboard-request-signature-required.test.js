const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner');
const { closeMCPConnections } = require('../../dist/lib/protocols/mcp');

function buildClient(errorCode = 'request_signature_required') {
  return {
    executeTask: async task => {
      assert.equal(task, 'create_media_buy');
      return {
        adcp_error: {
          code: errorCode,
          message: errorCode === 'request_signature_required' ? 'Request signature required' : 'Invalid request',
        },
      };
    },
  };
}

function buildProfile(requiredFor = ['create_media_buy']) {
  return {
    name: 'stub',
    tools: [{ name: 'create_media_buy' }],
    raw_capabilities: {
      request_signing: {
        supported: true,
        required_for: requiredFor,
      },
    },
  };
}

function buildStoryboard(requires, agent) {
  return {
    id: 'unsigned_functional_media_buy',
    version: '1.0.0',
    title: 'Unsigned functional media buy',
    category: 'test',
    summary: '',
    narrative: '',
    ...(requires && { requires }),
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'create',
        title: 'Create media buy',
        steps: [
          {
            id: 'create_buy',
            title: 'Create media buy',
            task: 'create_media_buy',
            ...(agent && { agent }),
            stateful: true,
            sample_request: {
              account: { brand: { domain: 'example.com' }, operator: 'agency.example' },
              brand: { domain: 'example.com' },
              start_time: '2026-08-01T00:00:00Z',
              end_time: '2026-08-08T00:00:00Z',
              packages: [
                {
                  buyer_ref: 'pkg-1',
                  product_id: 'prod-1',
                  pricing_option_id: 'cpm-1',
                  budget: 1000,
                },
              ],
            },
            validations: [
              {
                check: 'field_present',
                path: 'media_buy_id',
                description: 'A successful response includes a media buy id',
              },
            ],
          },
        ],
      },
    ],
  };
}

function handleMcpHandshake(rpc, res, tools) {
  if (rpc.method === 'initialize') {
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'test-session' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'test', version: '1.0.0' } },
      })
    );
    return true;
  }
  if (rpc.method === 'notifications/initialized') {
    res.writeHead(202);
    res.end();
    return true;
  }
  if (rpc.method === 'tools/list') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result: { tools: tools.map(name => ({ name, inputSchema: { type: 'object' } })) },
      })
    );
    return true;
  }
  return false;
}

async function startRoutedAgent(requiredFor) {
  const tools = ['get_adcp_capabilities', 'create_media_buy'];
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    if (!body) {
      res.writeHead(200);
      res.end();
      return;
    }
    const rpc = JSON.parse(body);
    if (handleMcpHandshake(rpc, res, tools)) return;

    if (rpc.method !== 'tools/call') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } }));
      return;
    }

    const toolName = rpc.params?.name;
    requests.push(toolName);
    const structuredContent =
      toolName === 'get_adcp_capabilities'
        ? {
            adcp: {
              major_versions: [3],
              supported_versions: ['3.1'],
              idempotency: { supported: true, replay_ttl_seconds: 86400 },
            },
            supported_protocols: ['media_buy'],
            specialisms: ['sales-non-guaranteed'],
            request_signing: { supported: true, required_for: requiredFor },
          }
        : {
            adcp_error: {
              code: 'request_signature_required',
              message: 'Request signature required',
            },
          };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          ...(toolName === 'create_media_buy' && { isError: true }),
          structuredContent,
        },
      })
    );
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    server,
    url: `http://127.0.0.1:${server.address().port}/mcp`,
  };
}

async function runRoutedCase({ primaryRequiredFor, secondaryRequiredFor }) {
  const primary = await startRoutedAgent(primaryRequiredFor);
  const secondary = await startRoutedAgent(secondaryRequiredFor);
  try {
    const result = await runStoryboard('', buildStoryboard(undefined, 'secondary'), {
      protocol: 'mcp',
      allow_http: true,
      agents: {
        primary: { url: primary.url },
        secondary: { url: secondary.url },
      },
    });
    return {
      step: result.phases[0].steps[0],
      primaryRequests: [...primary.requests],
      secondaryRequests: [...secondary.requests],
      secondaryUrl: secondary.url,
    };
  } finally {
    await closeMCPConnections();
    await Promise.all([
      new Promise(resolve => primary.server.close(resolve)),
      new Promise(resolve => secondary.server.close(resolve)),
    ]);
  }
}

async function runCase({ errorCode, requiredFor, requires } = {}) {
  const profile = buildProfile(requiredFor);
  const result = await runStoryboard('https://stub.example/mcp', buildStoryboard(requires), {
    protocol: 'mcp',
    allow_http: true,
    agentTools: ['create_media_buy'],
    _client: buildClient(errorCode),
    _profile: profile,
  });
  return result.phases[0].steps[0];
}

describe('unsigned functional request-signing guard (adcp-client#2373)', () => {
  test('grades a capability-declared signature-required rejection not_applicable', async () => {
    const result = await runCase();

    assert.equal(result.skipped, true);
    assert.equal(result.skip_reason, 'not_applicable');
    assert.equal(result.skip.reason, 'not_applicable');
    assert.match(result.skip.detail, /request_signing\.required_for/);
    assert.match(result.skip.detail, /create_media_buy/);
    assert.deepEqual(result.validations, [], 'authored validations must not run for the expected rejection');
  });

  test('does not skip a different error code', async () => {
    const result = await runCase({ errorCode: 'INVALID_REQUEST' });

    assert.notEqual(result.skipped, true);
    assert.equal(result.passed, false);
  });

  test('does not skip when the task is absent from request_signing.required_for', async () => {
    const result = await runCase({ requiredFor: ['update_media_buy'] });

    assert.notEqual(result.skipped, true);
    assert.equal(result.passed, false);
  });

  test('does not skip a storyboard that requires a request signer', async () => {
    const result = await runCase({ requires: ['request_signer'] });

    assert.notEqual(result.skipped, true);
    assert.equal(result.passed, false);
  });

  test('uses the routed agent profile when only the secondary requires the task signature', async () => {
    const result = await runRoutedCase({
      primaryRequiredFor: [],
      secondaryRequiredFor: ['create_media_buy'],
    });

    assert.equal(result.step.agent_url, result.secondaryUrl);
    assert.equal(result.step.skipped, true);
    assert.equal(result.step.skip_reason, 'not_applicable');
    assert.equal(result.primaryRequests.includes('create_media_buy'), false);
    assert.equal(result.secondaryRequests.includes('create_media_buy'), true);
  });

  test('does not skip from the primary profile when the routed secondary does not require the task signature', async () => {
    const result = await runRoutedCase({
      primaryRequiredFor: ['create_media_buy'],
      secondaryRequiredFor: [],
    });

    assert.equal(result.step.agent_url, result.secondaryUrl);
    assert.notEqual(result.step.skipped, true);
    assert.equal(result.step.passed, false);
    assert.equal(result.primaryRequests.includes('create_media_buy'), false);
    assert.equal(result.secondaryRequests.includes('create_media_buy'), true);
  });
});
