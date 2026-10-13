const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerDefaultInvariants } = require('../../dist/lib/testing/storyboard/default-invariants.js');
const { getAssertion } = require('../../dist/lib/testing/storyboard/assertions.js');
registerDefaultInvariants();
const assertion = getAssertion('account.sync_contract');
const entry = {
  brand: { domain: 'brand.example' },
  operator: 'operator.example',
  billing: 'agent',
  payment_terms: 'net_60',
};
const row = { account_id: 'stable', billing: 'agent', payment_terms: 'net_60', action: 'created', status: 'active' };
function step(key, result = row, request = entry) {
  return {
    task: 'sync_accounts',
    step_id: key,
    request: { payload: { accounts: [request], idempotency_key: key } },
    response: { accounts: [result] },
  };
}
function run(steps) {
  const ctx = { state: {}, agentUrl: 'https://seller.example' };
  return steps.flatMap(step => assertion.onStep(ctx, step));
}
test('account storyboard invariant permits replay and repeat sync with a fresh key', () => {
  assert.ok(run([step('first'), step('first'), step('second', { ...row, action: 'unchanged' })]).every(r => r.passed));
});
test('account storyboard invariant rejects duplicate identity and action created', () => {
  for (const change of [{ action: 'created' }, { account_id: 'duplicate', action: 'updated' }])
    assert.equal(run([step('first'), step('second', { ...row, ...change })])[1].passed, false);
});
test('account storyboard invariant rejects silent term changes and accepts rejection', () => {
  assert.equal(run([step('first', { ...row, payment_terms: 'net_30' })])[0].passed, false);
  assert.deepEqual(run([step('first', { ...row, action: 'failed', status: 'rejected' })]), []);
});
test('list_accounts exposes billing and terms for known agent-billed accounts', () => {
  for (const missing of ['billing', 'payment_terms']) {
    const results = run([
      step('first'),
      { task: 'list_accounts', step_id: 'list', response: { accounts: [{ ...row, [missing]: undefined }] } },
    ]);
    assert.equal(results[1].passed, false);
  }
});
test('sandbox and currency identity variants do not collide', () => {
  for (const variant of [{ sandbox: true }, { currency: 'USD' }, { operator_unit: { id: 'unit' } }])
    assert.ok(
      run([step('first'), step('second', { ...row, account_id: 'variant' }, { ...entry, ...variant })]).every(
        r => r.passed
      )
    );
});

test('the example storyboard fails a seller that creates a new account for every sync', async () => {
  const fs = require('node:fs');
  const { parseStoryboard } = require('../../dist/lib/testing/storyboard/loader.js');
  const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');
  const storyboard = parseStoryboard(fs.readFileSync('examples/storyboards/account-sync-contract.yaml', 'utf8'));
  for (const duplicate of [false, true]) {
    let calls = 0;
    const result = await runStoryboard('https://seller.example/mcp', storyboard, {
      protocol: 'mcp',
      agentTools: ['sync_accounts', 'list_accounts'],
      _profile: { name: 'account-contract-fixture', tools: ['sync_accounts', 'list_accounts'] },
      _client: {
        getAgentInfo: async () => ({
          name: 'account-contract-fixture',
          tools: [{ name: 'sync_accounts' }, { name: 'list_accounts' }],
        }),
        syncAccounts: async args => {
          calls++;
          return {
            success: true,
            status: 'completed',
            data: {
              accounts: [
                {
                  ...args.accounts[0],
                  account_id: duplicate ? `account-${calls}` : 'stable',
                  action: calls === 1 || duplicate ? 'created' : 'unchanged',
                  status: 'active',
                },
              ],
            },
          };
        },
        listAccounts: async () => ({
          success: true,
          status: 'completed',
          data: { accounts: [{ ...entry, account_id: 'stable', name: 'Brand', status: 'active' }] },
        }),
      },
    });
    assert.equal(calls, 2);
    assert.equal(result.overall_passed, !duplicate, JSON.stringify(result));
  }
});

test('missing request keys do not exempt created actions, and agent billing cannot be remapped', () => {
  const first = step('first');
  const second = step('second');
  delete first.request.payload.idempotency_key;
  delete second.request.payload.idempotency_key;
  assert.equal(run([first, second])[1].passed, false);
  assert.equal(run([step('first', { ...row, billing: 'operator' })])[0].passed, false);
});
