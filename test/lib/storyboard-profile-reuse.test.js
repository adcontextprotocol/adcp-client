/**
 * Public storyboard profile reuse (adcp-client#2600).
 *
 * These tests use a deliberately unreachable URL. Reaching the expected tool
 * gates proves the supplied profile bypassed wire discovery, and omitting
 * agentTools proves the runner derived the gates from profile.tools.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { runStoryboard, runStoryboardStep } = require('../../dist/lib/testing/storyboard/index.js');
const { closeMCPConnections } = require('../../dist/lib/protocols/mcp.js');

function buildStoryboard(overrides = {}) {
  return {
    id: 'profile_reuse_test',
    version: '1.0.0',
    title: 'profile reuse test',
    category: 'test',
    summary: 'Exercises public storyboard profile reuse.',
    narrative: '',
    agent: { interaction_model: 'sync', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'p1',
        title: 'Phase 1',
        steps: [
          {
            id: 'step1',
            title: 'A gated read',
            task: 'get_products',
          },
        ],
      },
    ],
    ...overrides,
  };
}

const profile = {
  name: 'Reusable profile',
  tools: ['get_products'],
  raw_capabilities: {},
};

function handleMcpHandshake(rpc, res, tools) {
  if (rpc.method === 'initialize') {
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'profile-reuse-session' });
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

async function startRoutedAgent(tool, supportedProtocol) {
  const tools = ['get_adcp_capabilities', tool];
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

    const toolName = rpc.params?.name;
    requests.push(toolName);
    const structuredContent =
      toolName === 'get_adcp_capabilities'
        ? {
            adcp: { major_versions: [3], supported_versions: ['3.2'] },
            supported_protocols: [supportedProtocol],
          }
        : { ok: true };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { structuredContent } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    server,
    url: `http://127.0.0.1:${server.address().port}/mcp`,
  };
}

describe('StoryboardRunOptions.profile', () => {
  test('runStoryboard reuses profile and derives required_tools gating', async () => {
    const storyboard = buildStoryboard({ required_tools: ['sync_accounts'] });

    const result = await runStoryboard('http://fake-local-2600', storyboard, { profile });

    assert.equal(result.overall_passed, true);
    assert.equal(result.skipped_count, 1);
    assert.equal(result.failed_count, 0);
    assert.equal(result.phases[0].steps[0].skip_reason, 'missing_tool');
    assert.match(result.phases[0].steps[0].skip.detail, /sync_accounts/);
  });

  test('runStoryboardStep reuses profile and derives requires_tool gating', async () => {
    const storyboard = buildStoryboard();
    storyboard.phases[0].steps[0].requires_tool = 'sync_accounts';

    const result = await runStoryboardStep('http://fake-local-2600', storyboard, 'step1', { profile });

    assert.equal(result.passed, true);
    assert.equal(result.skipped, true);
    assert.equal(result.skip_reason, 'missing_tool');
    assert.match(result.skip.detail, /sync_accounts/);
  });

  test('empty profiles remain authoritative for both runner entry points', async () => {
    const emptyProfile = { name: 'Empty profile', tools: [] };
    const storyboard = buildStoryboard();

    const fullResult = await runStoryboard('http://fake-local-2600', storyboard, { profile: emptyProfile });
    const stepResult = await runStoryboardStep('http://fake-local-2600', storyboard, 'step1', {
      profile: emptyProfile,
    });

    assert.equal(fullResult.phases[0].steps[0].skip_reason, 'missing_tool');
    assert.equal(stepResult.skip_reason, 'missing_tool');
  });

  test('explicit agentTools takes precedence over profile-derived tools', async () => {
    let calls = 0;
    const client = {
      getProducts: async () => {
        calls += 1;
        return { success: true, data: { products: [] } };
      },
    };
    const storyboard = buildStoryboard();
    storyboard.phases[0].steps[0].sample_request = { buying_mode: 'brief', brief: 'test' };

    const result = await runStoryboard('https://stub.example/mcp', storyboard, {
      _client: client,
      profile: { name: 'Empty profile', tools: [] },
      agentTools: ['get_products'],
    });

    assert.equal(calls, 1);
    assert.equal(result.phases[0].steps[0].skipped, undefined);
  });

  test('public profile takes precedence over the deprecated internal profile', async () => {
    const storyboard = buildStoryboard({ required_tools: ['sync_accounts'] });

    const result = await runStoryboard('http://fake-local-2600', storyboard, {
      profile,
      _profile: { name: 'Legacy profile', tools: ['sync_accounts'] },
    });

    assert.equal(result.skipped_count, 1);
    assert.equal(result.phases[0].steps[0].skip_reason, 'missing_tool');
  });

  test('legacy internal profiles still normalize object-shaped tool entries', async () => {
    let calls = 0;
    const client = {
      getProducts: async () => {
        calls += 1;
        return { success: true, data: { products: [] } };
      },
    };
    const storyboard = buildStoryboard();
    storyboard.phases[0].steps[0].sample_request = { buying_mode: 'brief', brief: 'test' };

    const result = await runStoryboard('https://stub.example/mcp', storyboard, {
      _client: client,
      _profile: { name: 'Legacy profile', tools: [{ name: 'get_products' }] },
    });

    assert.equal(calls, 1);
    assert.equal(result.phases[0].steps[0].skipped, undefined);
  });

  test('routed discovery replaces default-profile tools with the routed union', async () => {
    const sales = await startRoutedAgent('__test_sales_profile_reuse', 'media_buy');
    const signals = await startRoutedAgent('__test_signals_profile_reuse', 'signals');
    const storyboard = buildStoryboard({
      phases: [
        {
          id: 'p1',
          title: 'Phase 1',
          steps: [
            {
              id: 'step1',
              title: 'A routed signals call',
              task: '__test_signals_profile_reuse',
              agent: 'signals',
              auth: 'none',
              sample_request: {},
            },
          ],
        },
      ],
    });

    try {
      const result = await runStoryboard('', storyboard, {
        allow_http: true,
        profile: { ...profile, supported_protocols: ['media_buy'] },
        agents: {
          sales: { url: sales.url },
          signals: { url: signals.url },
        },
        default_agent: 'sales',
      });

      const step = result.phases[0].steps[0];
      assert.equal(step.skipped, undefined);
      assert.equal(step.passed, true);
      assert.ok(signals.requests.includes('__test_signals_profile_reuse'));
    } finally {
      await closeMCPConnections();
      await Promise.all([
        new Promise(resolve => sales.server.close(resolve)),
        new Promise(resolve => signals.server.close(resolve)),
      ]);
    }
  });
});
