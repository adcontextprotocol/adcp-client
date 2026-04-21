// Integration: the uniform-error-response invariant wired through the
// conformance harness, against an in-process MCP agent with two tenants.
//
// Verifies the baseline path (single token, two fresh UUIDs) and the
// cross-tenant path (tenant-A-owned id + fresh UUID, probed as tenant B).
// Exercises three seller shapes:
//   - compliant → invariant passes
//   - leaks error.code for cross-tenant-id → invariant fails on error.code
//   - echoes request id inside error.details → invariant fails on error.details

const { test, describe, after } = require('node:test');
const assert = require('node:assert');

const { runConformance } = require('../../dist/lib/conformance/index.js');
const { serve, createAdcpServer, adcpError } = require('../../dist/lib/index.js');
const { verifyApiKey } = require('../../dist/lib/server/index.js');

const TENANT_A_TOKEN = 'tenant_a_key';
const TENANT_B_TOKEN = 'tenant_b_key';
const A_LIST_ID = 'list_owned_by_a';

/**
 * @param {'compliant' | 'leak_code' | 'echo_id_in_details'} shape
 *   Seller behavior: compliant returns identical errors, leak_code branches
 *   error code by tenant ownership, echo_id_in_details echoes the probe id
 *   in error.details (a per-probe leak even for a single tenant).
 */
function makeAgent(shape) {
  return serve(
    () =>
      createAdcpServer({
        name: 'Uniform Error Test Agent',
        version: '1.0.0',
        governance: {
          getPropertyList: async (params, ctx) => {
            const token = ctx.authInfo?.token;
            const { list_id } = params;
            const ownedByA = list_id === A_LIST_ID;

            if (shape === 'leak_code') {
              if (ownedByA && token !== TENANT_A_TOKEN) {
                // Leaks existence: distinguishes "exists but not yours"
                // from "does not exist".
                return adcpError('PERMISSION_DENIED', { message: 'You cannot access this property list' });
              }
              if (ownedByA && token === TENANT_A_TOKEN) {
                return { list: minimalPropertyList(A_LIST_ID) };
              }
              return adcpError('REFERENCE_NOT_FOUND', { message: 'Property list not found' });
            }

            if (shape === 'echo_id_in_details') {
              // Compliant code/message but echoes the id into details —
              // per-probe divergence that defeats byte-equivalence even
              // without cross-tenant knowledge.
              return adcpError('REFERENCE_NOT_FOUND', {
                message: 'Property list not found',
                details: { looked_up: list_id },
              });
            }

            // Compliant: both "other tenant" and "does not exist" return
            // identical REFERENCE_NOT_FOUND. Tenant A can still see its own.
            if (ownedByA && token === TENANT_A_TOKEN) {
              return { list: minimalPropertyList(A_LIST_ID) };
            }
            return adcpError('REFERENCE_NOT_FOUND', { message: 'Property list not found' });
          },
        },
      }),
    {
      port: 0,
      onListening: () => {},
      authenticate: verifyApiKey({
        keys: {
          [TENANT_A_TOKEN]: { principal: 'tenant_a' },
          [TENANT_B_TOKEN]: { principal: 'tenant_b' },
        },
      }),
    }
  );
}

function minimalPropertyList(listId) {
  return {
    list_id: listId,
    name: 'Uniform error test list',
    is_live: true,
    properties: [],
  };
}

function waitForListening(server) {
  return new Promise(resolve => {
    if (server.listening) return resolve();
    server.on('listening', resolve);
  });
}

describe('conformance: uniform-error-response invariant', () => {
  const servers = [];
  after(() => {
    for (const s of servers) s.close();
  });

  async function start(shape) {
    const server = makeAgent(shape);
    servers.push(server);
    await waitForListening(server);
    return `http://localhost:${server.address().port}/mcp`;
  }

  test('baseline: compliant seller → pass', async () => {
    const url = await start('compliant');
    const report = await runConformance(url, {
      seed: 1,
      // Minimal run — just exercises the invariant without spending time
      // on the normal fuzz loop.
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
      tools: ['get_property_list'],
      turnBudget: 1,
      authToken: TENANT_A_TOKEN, // seeder/reference identity
      authTokenCrossTenant: TENANT_B_TOKEN, // prober
      fixtures: { list_ids: [A_LIST_ID] }, // stand in for seeder output
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
      tools: ['get_property_list'],
      turnBudget: 1,
      authToken: TENANT_A_TOKEN,
      authTokenCrossTenant: TENANT_B_TOKEN,
      // no fixtures — can't run cross-tenant mode without a seeded id
    });

    const invariant = report.uniformError.find(r => r.tool === 'get_property_list');
    assert.ok(invariant);
    assert.equal(invariant.mode, 'baseline');
    assert.equal(invariant.verdict, 'pass');
  });
});
