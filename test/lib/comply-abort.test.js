/**
 * Tests for comply() timeout_ms and signal options.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { comply } = require('../../dist/lib/testing/compliance/index.js');
const { ADCP_VERSION } = require('../../dist/lib/version.js');

function writeTimeoutComplianceCache() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-comply-timeout-'));
  fs.mkdirSync(path.join(dir, 'universal'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify(
      {
        adcp_version: ADCP_VERSION,
        generated_at: new Date().toISOString(),
        universal: ['slow-timeout-one', 'slow-timeout-two'],
        protocols: [],
        specialisms: [],
      },
      null,
      2
    )
  );
  fs.writeFileSync(path.join(dir, 'universal', 'slow-timeout-one.yaml'), timeoutStoryboardYaml('slow_timeout_one', 50));
  fs.writeFileSync(path.join(dir, 'universal', 'slow-timeout-two.yaml'), timeoutStoryboardYaml('slow_timeout_two', 0));
  return dir;
}

function timeoutStoryboardYaml(id, delayMs) {
  return `id: ${id}
version: 1.0.0
title: ${id}
category: testing
track: core
summary: ''
narrative: ''
agent:
  interaction_model: '*'
  capabilities: []
caller:
  role: buyer_agent
phases:
  - id: probe
    title: Probe
    steps:
      - id: probe
        title: Probe
        task: __test_probe
        sample_request:
          delay_ms: ${delayMs}
`;
}

async function startTimeoutAgent(options = {}) {
  const requests = [];
  const tools = ['__test_probe', 'get_adcp_capabilities'];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const rpc = raw ? JSON.parse(raw) : {};

    if (rpc.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'test-session' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            serverInfo: { name: 'timeout-test', version: '1.0.0' },
          },
        })
      );
      return;
    }
    if (rpc.method === 'notifications/initialized') {
      res.writeHead(202);
      res.end();
      return;
    }
    if (rpc.method === 'tools/list') {
      if (options.toolsListDelayMs) await new Promise(resolve => setTimeout(resolve, options.toolsListDelayMs));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: { tools: tools.map(name => ({ name, inputSchema: { type: 'object' } })) },
        })
      );
      return;
    }

    const toolName = rpc.params?.name;
    const args = rpc.params?.arguments ?? {};
    requests.push({ tool: toolName, args });

    if (toolName === '__test_probe') {
      options.onProbeStart?.(args);
      if (args.delay_ms) await new Promise(resolve => setTimeout(resolve, args.delay_ms));
      options.onProbeFinish?.(args);
      return okTool(res, rpc.id, { probed: true });
    }
    if (toolName === 'get_adcp_capabilities') {
      return okTool(res, rpc.id, {
        adcp: {
          major_versions: [3],
          supported_versions: ['3.1-rc.10'],
          build_version: ADCP_VERSION,
          idempotency: { supported: false },
        },
        supported_protocols: ['brand'],
        specialisms: [],
      });
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result: { isError: true, structuredContent: { error: `unknown tool ${toolName}` } },
      })
    );
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, requests, url: `http://127.0.0.1:${server.address().port}/mcp` };
}

async function startUnauthorizedAgent() {
  const server = http.createServer((_req, res) => {
    res.writeHead(401, {
      'content-type': 'application/json',
      'www-authenticate': 'Bearer realm="test"',
    });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/mcp` };
}

function okTool(res, id, structuredContent) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: {
        structuredContent,
        content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      },
    })
  );
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

describe('comply() signal option', () => {
  test('rejects with AbortError when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () => comply('https://unreachable.test/mcp', { signal: controller.signal }),
      err => {
        assert.ok(
          err.name === 'AbortError' || err.message?.includes('aborted'),
          `Expected AbortError, got: ${err.name} - ${err.message}`
        );
        return true;
      }
    );
  });

  test('rejects with custom reason when signal aborted with reason', async () => {
    const controller = new AbortController();
    controller.abort(new Error('shutdown'));

    await assert.rejects(
      () => comply('https://unreachable.test/mcp', { signal: controller.signal }),
      err => {
        assert.ok(err.message?.includes('shutdown'), `Expected shutdown reason, got: ${err.message}`);
        return true;
      }
    );
  });
});

describe('comply() timeout_ms option', () => {
  test('timeout_ms stops new storyboards without aborting the active storyboard', async () => {
    const complianceDir = writeTimeoutComplianceCache();
    const realDateNow = Date.now;
    const fixedStart = realDateNow();
    let budgetExpired = false;
    Date.now = () => (budgetExpired ? fixedStart + 1000 : fixedStart);
    const agent = await startTimeoutAgent({
      onProbeStart: () => {
        budgetExpired = true;
      },
    });
    try {
      const result = await comply(agent.url, {
        allow_http: true,
        complianceDir,
        storyboards: ['slow_timeout_one', 'slow_timeout_two'],
        timeout_ms: 500,
      });

      assert.notStrictEqual(result.overall_status, 'unreachable');
      assert.strictEqual(result.overall_status, 'partial');
      assert.deepStrictEqual(result.storyboards_executed, ['slow_timeout_one']);
      assert.strictEqual(agent.requests.filter(r => r.tool === '__test_probe').length, 1);
      assert.ok(
        result.observations.some(o => o.source?.code === 'timeout-budget-exceeded'),
        `expected timeout-budget-exceeded observation, got ${JSON.stringify(result.observations)}`
      );
    } finally {
      Date.now = realDateNow;
      await closeServer(agent.server);
      fs.rmSync(complianceDir, { recursive: true, force: true });
    }
  });

  test('timeout_ms waits for discovery, then stops before starting storyboards', async () => {
    const complianceDir = writeTimeoutComplianceCache();
    const agent = await startTimeoutAgent({ toolsListDelayMs: 50 });
    try {
      const result = await comply(agent.url, {
        allow_http: true,
        complianceDir,
        storyboards: ['slow_timeout_one'],
        timeout_ms: 1,
      });

      assert.strictEqual(result.overall_status, 'partial');
      assert.deepStrictEqual(result.storyboards_executed, []);
      assert.strictEqual(agent.requests.filter(r => r.tool === '__test_probe').length, 0);
      assert.ok(result.observations.some(o => o.source?.code === 'timeout-budget-exceeded'));
    } finally {
      await closeServer(agent.server);
      fs.rmSync(complianceDir, { recursive: true, force: true });
    }
  });

  test('timeout_ms reports skipped tracks in degraded auth fallback before starting storyboards', async () => {
    const complianceDir = writeTimeoutComplianceCache();
    const agent = await startUnauthorizedAgent();
    try {
      const result = await comply(agent.url, {
        allow_http: true,
        complianceDir,
        storyboards: ['slow_timeout_one'],
        timeout_ms: 1,
      });

      assert.strictEqual(result.overall_status, 'partial');
      assert.deepStrictEqual(result.storyboards_executed, []);
      assert.ok(result.tracks.some(t => t.track === 'core' && t.status === 'skip'));
      assert.ok(result.skipped_tracks.some(t => t.track === 'core'));
      assert.ok(result.observations.some(o => o.source?.code === 'timeout-budget-exceeded'));
    } finally {
      await closeServer(agent.server);
      fs.rmSync(complianceDir, { recursive: true, force: true });
    }
  });

  test('rejects with TypeError for timeout_ms: 0', async () => {
    await assert.rejects(
      () => comply('https://unreachable.test/mcp', { timeout_ms: 0 }),
      err => {
        assert.ok(err instanceof TypeError, `Expected TypeError, got ${err.constructor.name}`);
        assert.ok(err.message.includes('positive finite number'), err.message);
        return true;
      }
    );
  });

  test('rejects with TypeError for negative timeout_ms', async () => {
    await assert.rejects(
      () => comply('https://unreachable.test/mcp', { timeout_ms: -1 }),
      err => {
        assert.ok(err instanceof TypeError);
        return true;
      }
    );
  });

  test('rejects with TypeError for NaN timeout_ms', async () => {
    await assert.rejects(
      () => comply('https://unreachable.test/mcp', { timeout_ms: NaN }),
      err => {
        assert.ok(err instanceof TypeError);
        return true;
      }
    );
  });

  test('rejects with TypeError for Infinity timeout_ms', async () => {
    await assert.rejects(
      () => comply('https://unreachable.test/mcp', { timeout_ms: Infinity }),
      err => {
        assert.ok(err instanceof TypeError);
        return true;
      }
    );
  });
});

describe('comply() combined timeout_ms + signal', () => {
  test('signal abort takes precedence when already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller canceled'));

    await assert.rejects(
      () =>
        comply('https://unreachable.test/mcp', {
          timeout_ms: 60000,
          signal: controller.signal,
        }),
      err => {
        assert.ok(err.message?.includes('caller canceled'), `Expected caller reason, got: ${err.message}`);
        return true;
      }
    );
  });

  test('signal aborts an active storyboard step', async () => {
    const complianceDir = writeTimeoutComplianceCache();
    const controller = new AbortController();
    const agent = await startTimeoutAgent({
      onProbeStart: () => controller.abort(new Error('caller canceled mid-step')),
    });

    try {
      await assert.rejects(
        () =>
          comply(agent.url, {
            allow_http: true,
            complianceDir,
            storyboards: ['slow_timeout_one'],
            signal: controller.signal,
          }),
        err => {
          assert.ok(err.message?.includes('caller canceled mid-step'), `Expected caller reason, got: ${err.message}`);
          return true;
        }
      );
    } finally {
      await closeServer(agent.server);
      fs.rmSync(complianceDir, { recursive: true, force: true });
    }
  });
});
