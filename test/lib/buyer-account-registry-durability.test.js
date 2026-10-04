const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BuyerAccountRegistry } = require('../../dist/lib');
const account = { brand: { domain: 'brand.example' }, operator: 'agency.example' };
const response = () => ({
  success: true,
  status: 'completed',
  metadata: {},
  data: { accounts: [{ ...account, account_id: 'seller-id', status: 'active', action: 'created' }] },
});
function storage() {
  const rows = new Map();
  return {
    rows,
    async get(key) {
      return structuredClone(rows.get(key));
    },
    async set() {
      assert.fail('atomic storage must never use unguarded set');
    },
    async compareAndSet(key, revision, value) {
      if (rows.get(key)?.revision !== revision) return false;
      rows.set(key, structuredClone({ ...value, revision: (revision ?? 0) + 1 }));
      return true;
    },
  };
}
test('two processes sharing CAS storage dispatch only once and reload results', async () => {
  const store = storage();
  let release,
    calls = 0;
  const provision = async () => {
    calls++;
    await new Promise(resolve => {
      release = resolve;
    });
    return response();
  };
  const first = new BuyerAccountRegistry(() => 'principal:seller', provision, store);
  const second = new BuyerAccountRegistry(() => 'principal:seller', provision, store);
  const pending = first.ensure(account, { idempotencyKey: 'caller-owned-key-0001' });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(second.ensure(account, { idempotencyKey: 'caller-owned-key-0001' }), /claimed|in doubt/);
  assert.equal(calls, 1);
  release();
  const settled = await pending;
  assert.equal(settled.account_id, 'seller-id');
  assert.equal((await second.ensure(account)).account_id, 'seller-id');
  assert.equal(calls, 1);
});
test('dispatch ledger is awaited after claim, before transport, and before outcome storage', async () => {
  const store = storage(),
    order = [];
  let claimed;
  const registry = new BuyerAccountRegistry(
    () => 'scope',
    async (_, __, ___, dispatch) => {
      order.push('transport');
      assert.equal(dispatch.idempotencyKey, 'caller-owned-key-0002');
      return response();
    },
    store,
    undefined,
    {
      onDispatchStart: async dispatch => {
        order.push('start');
        claimed = await store.get(dispatch.storageKey);
        assert.equal(claimed.status, 'provisioning');
        assert.equal(claimed.dispatch.idempotencyKey, 'caller-owned-key-0002');
      },
      onResult: async dispatch => {
        order.push('result');
        assert.equal((await store.get(dispatch.storageKey)).status, 'provisioning');
        assert.equal(dispatch.result.success, true);
      },
    }
  );
  await registry.ensure(account, { idempotencyKey: 'caller-owned-key-0002' });
  assert.deepEqual(order, ['start', 'transport', 'result']);
});
test('crash uncertainty survives restart and caller-owned expired keys are never rotated', async () => {
  const store = storage();
  const registry = new BuyerAccountRegistry(
    () => 'scope',
    async (_, __, ___, dispatch) => {
      assert.equal(dispatch.idempotencyKey, 'caller-owned-key-0002');
      throw new Error('connection reset after dispatch');
    },
    store
  );
  await assert.rejects(registry.ensure(account, { idempotencyKey: 'caller-owned-key-0002' }), /connection reset/);
  const restarted = new BuyerAccountRegistry(
    () => 'scope',
    async () => assert.fail('no automatic retry'),
    store
  );
  await assert.rejects(restarted.ensure(account, { idempotencyKey: 'caller-owned-key-0003' }), /claimed|in doubt/);
  await restarted.observeSync([account], response().data.accounts);
  assert.equal((await restarted.ensure(account)).status, 'active');
  let calls = 0;
  const expired = new BuyerAccountRegistry(
    () => 'other',
    async (_, __, ___, dispatch) => {
      calls++;
      assert.equal(dispatch.idempotencyKey, 'caller-expired-key-01');
      return {
        success: false,
        status: 'failed',
        metadata: {},
        adcpError: { code: 'IDEMPOTENCY_EXPIRED', recovery: 'correctable', message: 'expired' },
      };
    }
  );
  await assert.rejects(expired.ensure(account, { idempotencyKey: 'caller-expired-key-01' }), /expired/i);
  assert.equal(calls, 1);
});
test('stale row writes cannot undo a competing authoritative repair', async () => {
  const store = storage();
  const registry = new BuyerAccountRegistry(
    () => 'scope',
    async () => response(),
    store
  );
  await registry.ensure(account);
  const entry = await registry.get(account);
  const [key] = [...store.rows].find(([, row]) => row.account.brand);
  assert.equal(await store.compareAndSet(key, entry.revision, { ...entry, status: 'suspended' }), true);
  assert.equal(await store.compareAndSet(key, entry.revision, { ...entry, status: 'active' }), false);
  assert.equal((await registry.get(account)).status, 'suspended');
});
test('dispatch-hook failure releases its claim before transport', async () => {
  const store = storage();
  const registry = new BuyerAccountRegistry(
    () => 'scope',
    async () => assert.fail('no dispatch'),
    store,
    undefined,
    {
      onDispatchStart: async () => {
        throw new Error('ledger unavailable');
      },
    }
  );
  await assert.rejects(registry.ensure(account), /ledger unavailable/);
  const [claim] = store.rows.values();
  assert.equal(claim.status, 'failed_provisioning');
  assert.equal(claim.dispatch, undefined);
});

test('submitted task identity is durable before the registry returns', async () => {
  const store = storage();
  const registry = new BuyerAccountRegistry(
    () => 'scope',
    async () => ({
      success: true,
      status: 'submitted',
      metadata: { taskId: 'local-task', serverTaskId: 'seller-task' },
    }),
    store
  );
  await registry.ensure(account);
  const entry = await registry.get(account);
  assert.equal(entry.pendingTaskId, 'seller-task');
  assert.ok(entry.dispatch.idempotencyKey);
  const restarted = new BuyerAccountRegistry(
    () => 'scope',
    async () => assert.fail('no second dispatch'),
    store
  );
  await assert.rejects(restarted.ensure(account), /claimed|in doubt/);
});
test('definitive initial rejection releases the claim; unknown failures retain it', async () => {
  for (const recovery of ['correctable', 'terminal', 'transient']) {
    const store = storage();
    const registry = new BuyerAccountRegistry(
      () => 'scope',
      async () => ({
        success: false,
        status: 'failed',
        metadata: {},
        adcpError: { code: 'ACCOUNT_SETUP_REQUIRED', recovery, message: 'rejected' },
      }),
      store
    );
    await assert.rejects(registry.ensure(account), /rejected/);
    assert.equal(
      (await registry.get(account)).status,
      recovery === 'transient' ? 'provisioning' : 'failed_provisioning'
    );
  }
});
test('caller keys are validated before any storage claim or dispatch', async () => {
  const store = storage();
  const registry = new BuyerAccountRegistry(
    () => 'scope',
    async () => assert.fail('no dispatch'),
    store
  );
  await assert.rejects(registry.ensure(account, { idempotencyKey: 'invalid key' }), /must match/);
  assert.equal(store.rows.size, 0);
});
test('late provisioning cannot overwrite a cross-process account repair', async () => {
  const store = storage();
  let finish;
  const first = new BuyerAccountRegistry(
    () => 'scope',
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
    store
  );
  const pending = first.ensure(account);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  const second = new BuyerAccountRegistry(
    () => 'scope',
    async () => assert.fail('no dispatch'),
    store
  );
  await second.observeSync(
    [account],
    response().data.accounts.map(row => ({ ...row, status: 'suspended' }))
  );
  finish(response());
  assert.equal((await pending).status, 'suspended');
  assert.equal((await second.get(account)).status, 'suspended');
});

test('ambiguous submitted completion keeps the durable claim and seller task ID', async () => {
  const store = storage();
  const registry = new BuyerAccountRegistry(
    () => 'scope',
    async () => ({
      success: true,
      status: 'submitted',
      metadata: { taskId: 'local', serverTaskId: 'seller-task' },
      submitted: {
        waitForCompletion: async () => ({ success: false, status: 'failed', metadata: {}, error: 'connection reset' }),
      },
    }),
    store
  );
  await assert.rejects(registry.ensure(account), /connection reset/);
  const entry = await registry.get(account);
  assert.equal(entry.status, 'provisioning');
  assert.equal(entry.pendingTaskId, 'seller-task');
  assert.ok(entry.dispatch.idempotencyKey);
});
test('an older completion cannot clear a newer dispatch claim', async () => {
  const store = storage();
  let complete, secondComplete;
  const first = new BuyerAccountRegistry(
    () => 'scope',
    async () => ({
      success: true,
      status: 'submitted',
      metadata: { taskId: 'local' },
      submitted: {
        waitForCompletion: () =>
          new Promise(resolve => {
            complete = resolve;
          }),
      },
    }),
    store
  );
  const old = first.ensure(account, { idempotencyKey: 'older-dispatch-key-01' });
  while (!complete) await new Promise(resolve => setImmediate(resolve));
  // The caller has explicitly settled the old dispatch and authorizes a new one.
  const [key, entry] = [...store.rows][0];
  await store.compareAndSet(key, entry.revision, { ...entry, status: 'failed_provisioning', dispatch: undefined });
  const second = new BuyerAccountRegistry(
    () => 'scope',
    () =>
      new Promise(resolve => {
        secondComplete = resolve;
      }),
    store
  );
  const newer = second.ensure(account, { idempotencyKey: 'newer-dispatch-key-01' });
  while (!secondComplete) await new Promise(resolve => setImmediate(resolve));
  complete({ success: true, status: 'completed', metadata: {}, data: { accounts: [] } });
  await assert.rejects(old, /did not establish/);
  const claimed = await second.get(account);
  assert.equal(claimed.status, 'provisioning');
  assert.equal(claimed.dispatch.idempotencyKey, 'newer-dispatch-key-01');
  secondComplete(response());
  await newer;
});

test('built-in registry persists dispatch and result hooks at the official MCP boundary', async t => {
  const { AgentClient } = require('../../dist/lib');
  const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server.js');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const store = storage();
  const order = [];
  let claimKey;
  const server = createAdcpServer({
    name: 'seller',
    version: '1.0.0',
    validation: { requests: 'off', responses: 'off' },
    capabilities: { account: { supportedBilling: ['operator'] } },
    accounts: {
      syncAccounts: async params => {
        order.push('transport');
        assert.equal(params.idempotency_key, 'persisted-mcp-dispatch-key');
        assert.equal((await store.get(claimKey)).dispatch.idempotencyKey, params.idempotency_key);
        return response().data;
      },
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: 'buyer', version: '1.0.0' });
  await mcp.connect(clientTransport);
  t.after(async () => {
    await mcp.close();
    await server.close();
  });
  const buyer = AgentClient.fromMCPClient(mcp, {
    validateFeatures: false,
    validation: { requests: 'off', responses: 'off' },
    accountStorage: store,
    accountRegistryScope: 'trusted-principal',
    accountRegistryOptions: {
      onDispatchStart: async dispatch => {
        order.push('start');
        claimKey = dispatch.storageKey;
        assert.equal((await store.get(claimKey)).status, 'provisioning');
      },
      onResult: async ({ result }) => {
        order.push('result');
        assert.equal(result.success, true);
        assert.equal((await store.get(claimKey)).status, 'provisioning');
      },
    },
  });
  const settled = await buyer.accounts.ensure(account, {
    billing: 'operator',
    idempotencyKey: 'persisted-mcp-dispatch-key',
  });
  assert.equal(settled.account_id, 'seller-id');
  assert.deepEqual(order, ['start', 'transport', 'result']);
});

test('synthetic MCP errors retain immediate and submitted dispatch claims', async () => {
  for (const submitted of [false, true]) {
    const store = storage();
    const failure = {
      success: false,
      status: 'failed',
      metadata: {},
      error: 'handler crashed after write',
      adcpError: { code: 'mcp_error', recovery: 'terminal', synthetic: true, message: 'handler crashed after write' },
    };
    const registry = new BuyerAccountRegistry(
      () => 'scope',
      async () =>
        submitted
          ? {
              success: true,
              status: 'submitted',
              metadata: { serverTaskId: 'seller-task' },
              submitted: { waitForCompletion: async () => failure },
            }
          : failure,
      store
    );
    await assert.rejects(
      registry.ensure(account, { idempotencyKey: 'synthetic-error-dispatch-key' }),
      /handler crashed/
    );
    const entry = await registry.get(account);
    assert.equal(entry.status, 'provisioning');
    assert.equal(entry.dispatch.idempotencyKey, 'synthetic-error-dispatch-key');
    await assert.rejects(registry.ensure(account), /claimed|in doubt/);
  }
});

test('expired replay keys preserve immediate and submitted claims until caller reconciliation', async () => {
  for (const [submitted, code] of [
    [false, 'IDEMPOTENCY_EXPIRED'],
    [true, 'IDEMPOTENCY_EXPIRED'],
    [false, 'IDEMPOTENCY_CONFLICT'],
    [true, 'IDEMPOTENCY_CONFLICT'],
  ]) {
    const store = storage();
    const failure = {
      success: false,
      status: 'failed',
      metadata: {},
      adcpError: { code, recovery: 'correctable', message: 'The key expired.' },
    };
    const registry = new BuyerAccountRegistry(
      () => 'scope',
      async () =>
        submitted
          ? {
              success: true,
              status: 'submitted',
              metadata: { serverTaskId: 'seller-task' },
              submitted: { waitForCompletion: async () => failure },
            }
          : failure,
      store
    );
    await assert.rejects(registry.ensure(account, { idempotencyKey: 'expired-caller-owned-key' }), /expired/);
    const entry = await registry.get(account);
    assert.equal(entry.status, 'provisioning');
    assert.equal(entry.dispatch.idempotencyKey, 'expired-caller-owned-key');
    await assert.rejects(registry.ensure(account), /claimed|in doubt/);
  }
});
