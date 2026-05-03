const { test, describe } = require('node:test');
const assert = require('node:assert');

const { syncGovernanceResponse } = require('../../dist/lib/server/responses.js');

describe('syncGovernanceResponse — write-only credential strip', () => {
  const account = { brand: { domain: 'acme.example' }, operator: 'pinnacle-agency.example' };

  test('strips authentication.credentials from every governance_agents row', () => {
    const data = {
      accounts: [
        {
          account,
          status: 'synced',
          governance_agents: [
            {
              url: 'https://gov.acme.example',
              authentication: { schemes: ['Bearer'], credentials: 'sk_super_secret_dont_leak_me' },
              categories: ['budget_authority'],
            },
          ],
        },
      ],
    };

    const wire = syncGovernanceResponse(data);
    const echoed = wire.structuredContent.accounts[0].governance_agents[0];

    assert.equal(echoed.url, 'https://gov.acme.example');
    assert.deepEqual(echoed.categories, ['budget_authority']);
    assert.equal(echoed.authentication, undefined, 'authentication MUST NOT be echoed');
    assert.equal(echoed.credentials, undefined);
    const text = JSON.stringify(wire);
    assert.ok(!text.includes('sk_super_secret_dont_leak_me'), 'credentials MUST NOT appear anywhere in the response');
  });

  test('passes through rows without governance_agents (failed status)', () => {
    const data = {
      accounts: [{ account, status: 'failed', errors: [{ code: 'PERMISSION_DENIED', message: 'no' }] }],
    };
    const wire = syncGovernanceResponse(data);
    const row = wire.structuredContent.accounts[0];
    assert.equal(row.status, 'failed');
    assert.deepEqual(row.errors, [{ code: 'PERMISSION_DENIED', message: 'no' }]);
  });

  test('passes through operation-level error shape unchanged', () => {
    const data = { errors: [{ code: 'SERVICE_UNAVAILABLE', message: 'down' }] };
    const wire = syncGovernanceResponse(data);
    assert.deepEqual(wire.structuredContent.errors, [{ code: 'SERVICE_UNAVAILABLE', message: 'down' }]);
  });

  test('strips credentials even when adopter spreads the entire input agent', () => {
    const inputAgent = {
      url: 'https://gov.example',
      authentication: { schemes: ['Bearer'], credentials: 'leaky_bearer' },
      categories: ['brand_policy'],
    };
    const data = {
      accounts: [{ account, status: 'synced', governance_agents: [{ ...inputAgent }] }],
    };
    const wire = syncGovernanceResponse(data);
    const echoed = wire.structuredContent.accounts[0].governance_agents[0];
    assert.equal(echoed.authentication, undefined);
    assert.ok(!JSON.stringify(wire).includes('leaky_bearer'));
  });

  test('preserves multiple agents per row', () => {
    const data = {
      accounts: [
        {
          account,
          status: 'synced',
          governance_agents: [
            { url: 'https://gov1.example', authentication: { schemes: ['Bearer'], credentials: 'a' } },
            {
              url: 'https://gov2.example',
              authentication: { schemes: ['Bearer'], credentials: 'b' },
              categories: ['c'],
            },
          ],
        },
      ],
    };
    const wire = syncGovernanceResponse(data);
    const agents = wire.structuredContent.accounts[0].governance_agents;
    assert.equal(agents.length, 2);
    assert.deepEqual(agents[0], { url: 'https://gov1.example' });
    assert.deepEqual(agents[1], { url: 'https://gov2.example', categories: ['c'] });
  });
});
