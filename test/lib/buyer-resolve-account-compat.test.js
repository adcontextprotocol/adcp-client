// SDK 14.0 buyer behavior with the default `accountPolicy: 'off'` and no
// registry configuration. The memoized account registry (#3093) is opt-in.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SingleAgentClient, AccountPendingApprovalError, AccountRequiredError } = require('../../dist/lib/index.js');

const agent = { id: 'seller', name: 'Seller', agent_uri: 'https://seller.example/mcp', protocol: 'mcp' };
const account = { brand: { domain: 'brand.example' }, operator: 'agency.example' };

function syncResult(status = 'active', action = 'created') {
  return {
    success: true,
    status: 'completed',
    metadata: {},
    data: { accounts: [{ ...account, account_id: 'seller-id', status, action }] },
  };
}

function client(config = {}) {
  const c = new SingleAgentClient(agent, config);
  c.getCapabilities = async () => ({ account: { requiredForProducts: false, supportedBilling: ['operator'] } });
  return c;
}

test('default resolveAccount re-syncs on every call and returns the natural key without account_id', async () => {
  const c = client();
  const sent = [];
  c.syncAccounts = async params => {
    sent.push(params);
    return syncResult();
  };
  const first = await c.resolveAccount({ ...account });
  const second = await c.resolveAccount({ ...account });
  assert.deepEqual(first, account);
  assert.deepEqual(second, account);
  assert.equal('account_id' in first, false);
  assert.equal(sent.length, 2, 'no memoization: every call reaches sync_accounts');
  assert.deepEqual(sent[0], { accounts: [{ ...account, billing: 'operator' }] });
  assert.equal(c._accounts, undefined, 'the registry is not created');
});

test('default resolveAccount observes a seller status change on the next call', async () => {
  const c = client();
  const statuses = ['active', 'pending_approval'];
  c.syncAccounts = async () => syncResult(statuses.shift());
  assert.deepEqual(await c.resolveAccount({ ...account }), account);
  await assert.rejects(c.resolveAccount({ ...account }), error => {
    assert.ok(error instanceof AccountPendingApprovalError);
    return true;
  });
});

test('default resolveAccount keeps the 14.0 errors for failed and inactive syncs', async () => {
  const failed = client();
  failed.syncAccounts = async () => ({ success: false, status: 'failed', error: 'payment', metadata: {} });
  await assert.rejects(
    failed.resolveAccount({ ...account }),
    /sync_accounts did not return a completed account result/
  );

  const rejected = client();
  rejected.syncAccounts = async () => syncResult('rejected', 'failed');
  await assert.rejects(rejected.resolveAccount({ ...account }), error => {
    assert.ok(error instanceof AccountRequiredError);
    assert.match(error.message, /did not establish an active account/);
    return true;
  });
});

test('default resolveAccount forwards new setup terms only when supplied', async () => {
  const c = client();
  const sent = [];
  c.syncAccounts = async params => {
    sent.push(params);
    return syncResult();
  };
  await c.resolveAccount({ ...account, paymentTerms: 'net_30' });
  assert.deepEqual(sent[0].accounts[0], { ...account, billing: 'operator', payment_terms: 'net_30' });
});

for (const [label, config] of [
  ['accountPolicy: auto', { accountPolicy: 'auto' }],
  ['accountRegistryScope', { accountRegistryScope: 'caller-a' }],
  ['accountRegistryMaxEntries', { accountRegistryMaxEntries: 100 }],
]) {
  test(`registry memoization is opt-in (${label})`, async () => {
    const c = client(config);
    let calls = 0;
    c.syncAccounts = async () => {
      calls++;
      return syncResult();
    };
    await c.resolveAccount({ ...account });
    await c.resolveAccount({ ...account });
    assert.equal(calls, 1);
  });
}

test('default getProducts and task finalization do not derive the registry credential scope', async () => {
  const c = client();
  let scopes = 0;
  c.accountScope = () => {
    scopes++;
    return 'scope';
  };
  c.executeAndHandle = async () => ({
    success: true,
    status: 'completed',
    metadata: {},
    data: { products: [], cache_scope: 'public' },
  });
  const result = await c.getProducts({ brief: 'sports', account });
  assert.equal(result.success, true);
  await c.finalizeTaskResult(syncResult(), {
    kind: 'single-agent',
    taskType: 'sync_accounts',
    canonical: false,
    productPolicyRequest: {},
  });
  assert.equal(scopes, 0);
  assert.equal(c._accounts, undefined);
});
