// Integration: the uniform-error-response invariant wired through the
// conformance harness, against an in-process A2A-shaped agent served over
// raw HTTP. Mirrors `uniform-error-invariant.test.js` (MCP) so A2A-shaped
// sellers get the same five-case coverage that MCP sellers do.
//
// The server implements the A2A JSON-RPC wire format directly (agent-card
// discovery + message/send) rather than wiring `@a2a-js/sdk/server`. The
// invariant is tested via the official `@a2a-js/sdk/client` (used by the
// AdcpClient A2A protocol adapter), which is what sellers interoperate
// with in the wild — that's the code path the capture, runner, and
// comparator must keep working over. The server is a thin responder that
// emits the canonical AdCP-over-A2A shape: a completed Task whose
// artifact carries a DataPart containing either the success payload or an
// `adcp_error`.
//
// Coverage intent:
//   - extractA2AState end-to-end: the comparator extracts task state from
//     the real SDK's wire response, not a hand-crafted JSON string.
//   - capturedProbe POST filter: each fresh-client probe emits a card
//     GET + a message/send POST; the heuristic must pick the POST.
//   - A2AClient cache reuse: both probes in a pair share one cached
//     client under the same token, which means one probe writes captures
//     for [GET,GET,POST] and the next for [POST]. Both must land a POST
//     capture.

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { randomUUID } = require('node:crypto');

const { runConformance } = require('../../dist/lib/conformance/index.js');
const { closeConnections } = require('../../dist/lib/protocols/index.js');

const TENANT_A_TOKEN = 'tenant_a_key';
const TENANT_B_TOKEN = 'tenant_b_key';
const A_LIST_ID = 'list_owned_by_a';

/**
 * Start an A2A-shaped seller whose `get_property_list` behavior is
 * controlled by `shape`. Returns `{ server, url }` where `url` is the
 * base that the conformance harness probes with `protocol: 'a2a'`.
 *
 * @param {'compliant' | 'leak_code' | 'echo_id_in_details'} shape
 */
async function startA2AAgent(shape) {
  let actualUrl;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          name: 'Uniform Error A2A Test Agent',
          description: 'Test seller for uniform-error-response invariant over A2A',
          protocolVersion: '0.3.0',
          version: '1.0.0',
          url: `${actualUrl}/a2a`,
          capabilities: { pushNotifications: false },
          defaultInputModes: ['application/json'],
          defaultOutputModes: ['application/json'],
          skills: [
            {
              id: 'get_property_list',
              name: 'get_property_list',
              description: 'Fetch a property list by id.',
              tags: ['test'],
            },
          ],
        })
      );
      return;
    }
    // The A2A client's first discovery probe tries /.well-known/agent.json
    // before /.well-known/agent-card.json. 404 that path cleanly so the
    // client falls through to the card URL.
    if (req.method === 'GET' && req.url === '/.well-known/agent.json') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    if (req.method === 'POST' && req.url === '/a2a') {
      handleJsonRpc(req, res, shape);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(resolve => server.listen(0, resolve));
  actualUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, url: actualUrl };
}

function handleJsonRpc(req, res, shape) {
  let body = '';
  req.on('data', chunk => (body += chunk));
  req.on('end', () => {
    let rpc;
    try {
      rpc = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'parse error' },
        })
      );
      return;
    }
    const token = extractBearer(req.headers.authorization);
    const result = dispatchSkill(rpc, token, shape);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
}

function extractBearer(header) {
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : undefined;
}

function dispatchSkill(rpc, token, shape) {
  const parts = rpc?.params?.message?.parts;
  const dataPart = Array.isArray(parts) ? parts.find(p => p?.kind === 'data') : undefined;
  const skill = dataPart?.data?.skill;
  const parameters = dataPart?.data?.parameters ?? {};

  let payload;
  if (skill === 'get_property_list') {
    payload = getPropertyList(parameters, token, shape);
  } else {
    payload = { adcp_error: { code: 'UNKNOWN_TOOL', message: `Unknown skill ${skill}` } };
  }

  return {
    kind: 'task',
    id: `task_${randomUUID()}`,
    contextId: `ctx_${randomUUID()}`,
    status: { state: 'completed', timestamp: new Date().toISOString() },
    artifacts: [
      {
        artifactId: `art_${randomUUID()}`,
        parts: [{ kind: 'data', data: payload }],
      },
    ],
  };
}

function getPropertyList(parameters, token, shape) {
  const listId = parameters.list_id;
  const ownedByA = listId === A_LIST_ID;

  if (shape === 'leak_code') {
    if (ownedByA && token !== TENANT_A_TOKEN) {
      return { adcp_error: { code: 'PERMISSION_DENIED', message: 'You cannot access this property list' } };
    }
    if (ownedByA && token === TENANT_A_TOKEN) {
      return { list: minimalPropertyList(A_LIST_ID) };
    }
    return { adcp_error: { code: 'REFERENCE_NOT_FOUND', message: 'Property list not found' } };
  }

  if (shape === 'echo_id_in_details') {
    return {
      adcp_error: {
        code: 'REFERENCE_NOT_FOUND',
        message: 'Property list not found',
        details: { looked_up: listId },
      },
    };
  }

  if (ownedByA && token === TENANT_A_TOKEN) {
    return { list: minimalPropertyList(A_LIST_ID) };
  }
  return { adcp_error: { code: 'REFERENCE_NOT_FOUND', message: 'Property list not found' } };
}

function minimalPropertyList(listId) {
  return {
    list_id: listId,
    name: 'Uniform error test list',
    is_live: true,
    properties: [],
  };
}

describe('conformance: uniform-error-response invariant (A2A)', () => {
  const servers = [];
  after(async () => {
    for (const s of servers) await new Promise(resolve => s.close(resolve));
    // Cached A2A clients outlive this suite. Drop them so a later suite
    // on the same port (rare but possible) doesn't reuse a stale entry.
    closeConnections('a2a');
  });

  async function start(shape) {
    const { server, url } = await startA2AAgent(shape);
    servers.push(server);
    return url;
  }

  test('baseline: compliant seller → pass', async () => {
    const url = await start('compliant');
    const report = await runConformance(url, {
      seed: 1,
      protocol: 'a2a',
      tools: ['get_property_list'],
      turnBudget: 1,
      authToken: TENANT_B_TOKEN,
    });

    const invariant = report.uniformError.find(r => r.tool === 'get_property_list');
    assert.ok(invariant, 'invariant entry for get_property_list');
    assert.equal(invariant.mode, 'baseline');
    assert.equal(invariant.verdict, 'pass', `unexpected differences: ${JSON.stringify(invariant.differences)}`);
  });

  test('baseline: seller echoes probe id in error.details → fail', async () => {
    const url = await start('echo_id_in_details');
    const report = await runConformance(url, {
      seed: 2,
      protocol: 'a2a',
      tools: ['get_property_list'],
      turnBudget: 1,
      authToken: TENANT_B_TOKEN,
    });

    const invariant = report.uniformError.find(r => r.tool === 'get_property_list');
    assert.ok(invariant);
    assert.equal(invariant.mode, 'baseline');
    assert.equal(invariant.verdict, 'fail');
    assert.ok(
      invariant.differences.some(d => d.startsWith('error.details diverges')),
      `expected error.details divergence, got: ${JSON.stringify(invariant.differences)}`
    );
  });

  test('cross-tenant: compliant seller → pass', async () => {
    const url = await start('compliant');
    const report = await runConformance(url, {
      seed: 3,
      protocol: 'a2a',
      tools: ['get_property_list'],
      turnBudget: 1,
      authToken: TENANT_A_TOKEN,
      authTokenCrossTenant: TENANT_B_TOKEN,
      fixtures: { list_ids: [A_LIST_ID] },
    });

    const invariant = report.uniformError.find(r => r.tool === 'get_property_list');
    assert.ok(invariant);
    assert.equal(invariant.mode, 'cross-tenant');
    assert.equal(invariant.verdict, 'pass', `unexpected differences: ${JSON.stringify(invariant.differences)}`);
  });

  test('cross-tenant: seller leaks via divergent error.code → fail', async () => {
    const url = await start('leak_code');
    const report = await runConformance(url, {
      seed: 4,
      protocol: 'a2a',
      tools: ['get_property_list'],
      turnBudget: 1,
      authToken: TENANT_A_TOKEN,
      authTokenCrossTenant: TENANT_B_TOKEN,
      fixtures: { list_ids: [A_LIST_ID] },
    });

    const invariant = report.uniformError.find(r => r.tool === 'get_property_list');
    assert.ok(invariant);
    assert.equal(invariant.mode, 'cross-tenant');
    assert.equal(invariant.verdict, 'fail');
    assert.ok(
      invariant.differences.some(d => d.startsWith('error.code diverges')),
      `expected error.code divergence, got: ${JSON.stringify(invariant.differences)}`
    );
  });

  test('baseline fallback: cross-tenant token supplied but no fixture → still runs as baseline', async () => {
    const url = await start('compliant');
    const report = await runConformance(url, {
      seed: 5,
      protocol: 'a2a',
      tools: ['get_property_list'],
      turnBudget: 1,
      authToken: TENANT_A_TOKEN,
      authTokenCrossTenant: TENANT_B_TOKEN,
    });

    const invariant = report.uniformError.find(r => r.tool === 'get_property_list');
    assert.ok(invariant);
    assert.equal(invariant.mode, 'baseline');
    assert.equal(invariant.verdict, 'pass');
  });
});
