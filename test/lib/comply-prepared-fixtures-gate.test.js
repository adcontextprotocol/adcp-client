/**
 * `comply()` refuses `prepared_fixtures` outright, before any seller contact.
 *
 * The option is absent from `ComplyOptions`, so no typed caller can pass
 * it — but `runOptions` is built by spreading the caller's object, so an
 * untyped one rode through to `runStoryboard` and was half-honoured:
 * comply selects its storyboard set from its OWN capability discovery,
 * which happens before any storyboard (and therefore any binding digest)
 * exists, so the gate could only fire after the agent had been contacted.
 *
 * Prepared state binds one storyboard digest; comply is a bundle
 * orchestrator. Refusing is the honest contract, and it is the only answer
 * that keeps "zero seller calls" true for every entry point that accepts
 * the option.
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { comply } = require('../../dist/lib/testing/compliance');
const { ADCP_VERSION } = require('../../dist/lib/version');

function writeCache() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-comply-gate-'));
  fs.mkdirSync(path.join(dir, 'universal'));
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify({ adcp_version: ADCP_VERSION, universal: ['probe'], protocols: [], specialisms: [] })
  );
  fs.writeFileSync(
    path.join(dir, 'universal', 'probe.yaml'),
    `id: probe
version: 1.0.0
title: probe
category: testing
track: core
summary: ''
narrative: ''
agent:
  interaction_model: '*'
  capabilities: []
caller:
  role: buyer_agent
invariants:
  disable: [status.monotonic, impairment.coherence]
phases:
  - id: flow
    title: Flow
    steps:
      - id: one
        title: one
        task: __test_probe
        sample_request: {}
        validations:
          - check: field_present
            path: probed
            description: probe answered
`
  );
  return dir;
}

async function startAgent() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rpc = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    requests.push(rpc.method === 'tools/call' ? `tool:${rpc.params?.name}` : rpc.method);
    if (rpc.method === 'notifications/initialized') return void res.writeHead(202).end();
    const reply = result =>
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    if (rpc.method === 'initialize') {
      return reply({ protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'gate', version: '1' } });
    }
    if (rpc.method === 'tools/list') {
      return reply({
        tools: ['__test_probe', 'get_adcp_capabilities'].map(name => ({ name, inputSchema: { type: 'object' } })),
      });
    }
    if (rpc.params?.name === 'get_adcp_capabilities') {
      return reply({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ status: 'completed', adcp: { major_versions: [3] }, supported_protocols: [] }),
          },
        ],
      });
    }
    return reply({ content: [{ type: 'text', text: JSON.stringify({ status: 'completed', probed: true }) }] });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    requests,
    reset: () => requests.splice(0, requests.length),
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

describe('comply() refuses prepared-state reuse', () => {
  let agent;
  let complianceDir;

  before(async () => {
    agent = await startAgent();
    complianceDir = writeCache();
  });
  after(async () => {
    await agent?.close();
    if (complianceDir) fs.rmSync(complianceDir, { recursive: true, force: true });
  });

  for (const [label, extra] of [
    ['with an authorizer', { prepared_fixtures_authorizer: () => ({ authorized: true }) }],
    ['with a denying authorizer', { prepared_fixtures_authorizer: () => ({ authorized: false }) }],
    ['with no authorizer at all', {}],
  ]) {
    test(`refuses ${label}, reaching the agent zero times`, async () => {
      agent.reset();
      await assert.rejects(
        () =>
          comply(agent.url, {
            allow_http: true,
            complianceDir,
            prepared_fixtures: { ref: 'opaque', resolve: () => undefined },
            ...extra,
          }),
        /comply\(\) does not accept prepared_fixtures/
      );
      assert.deepEqual(agent.requests, [], `comply contacted the agent: ${JSON.stringify(agent.requests)}`);
    });
  }

  test('the refusal names the entry points that do support reuse', async () => {
    agent.reset();
    await assert.rejects(
      () =>
        comply(agent.url, {
          allow_http: true,
          complianceDir,
          prepared_fixtures: { ref: 'opaque', resolve: () => undefined },
        }),
      /runStoryboard\(\) or runStoryboardStep\(\)/
    );
  });

  test('without prepared_fixtures, comply still runs normally', async () => {
    agent.reset();
    const result = await comply(agent.url, { allow_http: true, complianceDir });
    assert.ok(agent.requests.length > 0, 'the ordinary path must still contact the agent');
    assert.equal(result.storyboards_executed.length, 1);
  });
});
