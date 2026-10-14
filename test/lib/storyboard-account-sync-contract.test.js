const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../../dist/lib/testing/storyboard/default-invariants');
const { getAssertion } = require('../../dist/lib/testing/storyboard/assertions');
const spec = getAssertion('accounts.sync_contract');
const completeness = getAssertion('accounts.agent_billing_complete');
let stepId = 0;
const entry = {
  brand: { domain: 'acme.example' },
  operator: 'agency.example',
  billing: 'agent',
  payment_terms: 'net_60',
};
const row = { account_id: 'acct_1', ...entry, action: 'created', status: 'active' };
function context() {
  const ctx = { state: {}, storyboard: { phases: [] } };
  spec.onStart(ctx);
  completeness.onStart(ctx);
  return ctx;
}
function step(rows, payload = { accounts: [entry], idempotency_key: 'key-1' }, extra = {}) {
  return {
    task: 'sync_accounts',
    step_id: `s${stepId++}`,
    response: { accounts: rows },
    request: { payload },
    ...extra,
  };
}
const failed = results => results.some(r => !r.passed);
test('same natural key with new request key must retain id and report updated/unchanged', () => {
  for (const patch of [{ account_id: 'duplicate' }, { action: 'created' }]) {
    const ctx = context();
    spec.onStep(ctx, step([row]));
    assert.equal(
      failed(
        spec.onStep(
          ctx,
          step([{ ...row, action: 'unchanged', ...patch }], { accounts: [entry], idempotency_key: 'key-2' })
        )
      ),
      true
    );
  }
});
test('replay may report created but must retain id; distinct sandbox keys are independent', () => {
  const ctx = context();
  spec.onStep(ctx, step([row]));
  assert.equal(failed(spec.onStep(ctx, step([row]))), false);
  assert.equal(failed(spec.onStep(ctx, step([{ ...row, account_id: 'bad' }]))), true);
  assert.equal(
    failed(spec.onStep(ctx, step([{ ...row, account_id: 'sandbox' }], { accounts: [{ ...entry, sandbox: true }] }))),
    false
  );
});
test('active mismatched/missing terms and incomplete agent billing fail; explicit rejection is allowed', () => {
  for (const payment_terms of ['net_30'])
    assert.equal(failed(spec.onStep(context(), step([{ ...row, payment_terms }]))), true);
  assert.equal(failed(completeness.onStep(context(), step([{ ...row, billing: undefined }]))), true);
  assert.equal(failed(spec.onStep(context(), step([{ ...row, action: 'failed', status: 'rejected' }]))), false);
});
test('list rows include terms and billing for previously observed agent-billed account', () => {
  const ctx = context();
  completeness.onStep(ctx, step([row]));
  for (const patch of [{ billing: undefined }, { payment_terms: undefined }]) {
    assert.equal(failed(completeness.onStep(ctx, step([{ ...row, ...patch }], {}, { task: 'list_accounts' }))), true);
  }
});
test('dry runs do not establish account identity, skips do not grade', () => {
  const ctx = context();
  assert.deepEqual(spec.onStep(ctx, step([row], { accounts: [entry], dry_run: true })), []);
  assert.equal(failed(spec.onStep(ctx, step([{ ...row, account_id: 'real' }]))), false);
  assert.deepEqual(spec.onStep(ctx, step([{ ...row, payment_terms: 'bad' }], undefined, { skipped: true })), []);
});

test('default invariant accepts optional response omissions; certification completeness is opt in', () => {
  const ctx = context();
  assert.equal(spec.default, true);
  assert.equal(completeness.default, false);
  const omission = step([{ ...row, billing: undefined, payment_terms: undefined }]);
  assert.equal(failed(spec.onStep(ctx, omission)), false);
  assert.equal(failed(completeness.onStep(ctx, omission)), true);
});

test('duplicate entries within one request cannot identify different accounts', () => {
  const ctx = context();
  const result = spec.onStep(
    ctx,
    step([row, { ...row, account_id: 'duplicate' }], { accounts: [entry, entry], idempotency_key: 'same-batch' })
  );
  assert.equal(failed(result), true);
});

test('auth overrides have independent identities and reordered response rows match echoed keys', () => {
  const ctx = context();
  ctx.storyboard.phases = [{ steps: [{ id: 'first' }, { id: 'second', auth: { type: 'api_key', value: 'other' } }] }];
  spec.onStep(ctx, step([row], undefined, { step_id: 'first' }));
  assert.equal(
    failed(spec.onStep(ctx, step([{ ...row, account_id: 'other' }], undefined, { step_id: 'second' }))),
    false
  );
  const second = { ...entry, brand: { domain: 'other.example' }, payment_terms: 'net_30' };
  assert.equal(
    failed(
      spec.onStep(context(), step([{ ...row, ...second, account_id: 'two' }, row], { accounts: [entry, second] }))
    ),
    false
  );
});

test('partial brand echoes retain request subdivisions when matching identity and terms', () => {
  const ctx = context();
  const subdivided = { ...entry, brand: { ...entry.brand, brand_id: 'subdivision', countries: ['US'] } };
  spec.onStep(ctx, step([row], { accounts: [subdivided], idempotency_key: 'one' }));
  assert.equal(
    failed(
      spec.onStep(
        ctx,
        step([{ ...row, account_id: 'duplicate', action: 'unchanged' }], {
          accounts: [subdivided],
          idempotency_key: 'two',
        })
      )
    ),
    true
  );
  assert.equal(
    failed(spec.onStep(context(), step([{ ...row, payment_terms: 'net_30' }], { accounts: [subdivided] }))),
    true
  );
});

test('packaged certification storyboard grades repeated syncs and subsequent list rows', async () => {
  const { loadStoryboardFile } = require('../../dist/lib/testing/storyboard/loader');
  const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner');
  const { createKeyedAccountStore, keyedAccountMemoryBackend } = require('../../dist/lib/server');
  const { toWireAccount } = require('../../dist/lib/server/decisioning/account');
  const storyboard = loadStoryboardFile('examples/account-sync-contract.yaml');
  for (const mode of ['valid', 'duplicate', 'rejected', 'empty']) {
    const store = createKeyedAccountStore({
      namespace: 'storyboard-test',
      principalKey: ctx => ctx.authInfo?.credential?.key_id,
      backend: keyedAccountMemoryBackend(),
      createAccount(ref, id) {
        return { ...ref, id, name: 'Account', status: 'active', billing: { invoicedTo: 'agent' }, ctx_metadata: {} };
      },
    });
    let syncs = 0;
    const client = {
      getAgentInfo: async () => ({
        name: 'account-test',
        tools: [{ name: 'sync_accounts' }, { name: 'list_accounts' }],
      }),
      async executeTask(task, params) {
        const ctx = { authInfo: { credential: { kind: 'api_key', key_id: 'buyer' } }, input: params };
        if (task === 'sync_accounts') {
          let accounts = await store.upsert(params.accounts, ctx);
          if (mode === 'rejected')
            accounts = accounts.map(row => ({ ...row, account_id: undefined, action: 'failed', status: 'rejected' }));
          if (mode === 'empty') accounts = [];
          if (mode === 'duplicate' && syncs++ > 0)
            accounts[0] = { ...accounts[0], account_id: 'duplicate', action: 'created' };
          return { success: true, data: { accounts } };
        }
        return { success: true, data: { accounts: (await store.list(params, ctx)).items.map(toWireAccount) } };
      },
    };
    const result = await runStoryboard('https://stub.example/mcp', storyboard, {
      protocol: 'mcp',
      agentTools: ['sync_accounts', 'list_accounts'],
      _profile: { name: 'account-test', tools: [{ name: 'sync_accounts' }, { name: 'list_accounts' }] },
      _client: client,
    });
    assert.equal(result.overall_passed, mode === 'valid', JSON.stringify(result));
  }
});

test('controller resets and delete_missing invalidate previous identity proofs', () => {
  const ctx = context();
  spec.onStep(ctx, step([row]));
  spec.onStep(ctx, { ...step([], { scenario: 'reset_state' }), task: 'comply_test_controller', passed: true });
  assert.equal(failed(spec.onStep(ctx, step([{ ...row, account_id: 'after-reset' }]))), false);
  spec.onStep(ctx, step([], { accounts: [], delete_missing: true }));
  assert.equal(failed(spec.onStep(ctx, step([{ ...row, account_id: 'after-delete' }]))), false);
});

test('billing completeness does not join unrelated rows on absent IDs or stale billing models', () => {
  const ctx = context();
  completeness.onStep(ctx, step([{ ...row, account_id: undefined }]));
  assert.equal(
    failed(completeness.onStep(ctx, step([{ billing: 'operator', status: 'active' }], {}, { task: 'list_accounts' }))),
    false
  );
  completeness.onStep(ctx, step([row]));
  assert.equal(
    failed(
      completeness.onStep(
        ctx,
        step([{ ...row, billing: 'operator', payment_terms: undefined }], {}, { task: 'list_accounts' })
      )
    ),
    false
  );
});

test('same-batch duplicate rows may share one created account', () => {
  assert.equal(failed(spec.onStep(context(), step([row, row], { accounts: [entry, entry] }))), false);
});

test('duplicate account-ID settings entries do not crash either assertion', () => {
  const request = {
    accounts: [
      { account: { account_id: 'acct_1' }, payment_terms: 'net_60' },
      { account: { account_id: 'acct_1' }, payment_terms: 'net_60' },
    ],
  };
  const response = step(
    [
      { ...row, action: 'updated' },
      { ...row, action: 'unchanged' },
    ],
    request
  );
  assert.equal(failed(spec.onStep(context(), response)), false);
  assert.equal(failed(completeness.onStep(context(), response)), false);
});

test('seller replay claims and changed payloads cannot bypass a fresh-request identity check', () => {
  for (const request of [
    { accounts: [entry], idempotency_key: 'new-key' },
    { accounts: [{ ...entry, payment_terms: 'net_30' }], idempotency_key: 'key-1' },
  ]) {
    const ctx = context();
    spec.onStep(ctx, step([row]));
    assert.equal(
      failed(spec.onStep(ctx, step([row], request, { response: { accounts: [row], replayed: true } }))),
      true
    );
  }
});

test('explicit billing and pending-term remaps fail the default sync assertion', () => {
  assert.equal(failed(spec.onStep(context(), step([{ ...row, billing: 'operator' }]))), true);
  assert.equal(
    failed(spec.onStep(context(), step([{ ...row, status: 'pending_approval', payment_terms: 'net_30' }]))),
    true
  );
});
