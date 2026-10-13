'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
const { AccountNotFoundError } = require('../dist/lib/server/decisioning/account');
const { createIdempotencyStore, memoryBackend } = require('../dist/lib/server/idempotency');
const { randomUUID } = require('node:crypto');
process.env.NODE_ENV = 'test';
const entry = {
  brand: { domain: 'acme.example' },
  operator: 'agency.example',
  billing: 'agent',
  payment_terms: 'net_60',
  sandbox: true,
};
const account = {
  id: 'acct_1',
  name: 'Acme',
  brand: entry.brand,
  operator: entry.operator,
  status: 'active',
  billing: { invoicedTo: 'agent' },
  payment_terms: 'net_60',
  sandbox: true,
  ctx_metadata: {},
};
const row = {
  account_id: account.id,
  brand: entry.brand,
  operator: entry.operator,
  action: 'unchanged',
  status: 'active',
  sandbox: true,
};
function setup(store, opts = {}) {
  const diagnostics = [];
  const warnings = [];
  const server = createAdcpServerFromPlatform(
    {
      capabilities: {
        specialisms: ['signal-marketplace'],
        pricingModels: ['cpm'],
        supportedBillings: ['agent', 'operator'],
      },
      signals: { getSignals: async () => ({ signals: [] }), activateSignal: async () => ({}) },
      accounts: { onDiagnostic: d => diagnostics.push(d), ...store },
    },
    {
      name: 'account-contract',
      version: '1.0',
      validation: { requests: 'off', responses: 'off' },
      logger: {
        debug() {},
        info() {},
        error() {},
        warn(message, fields) {
          warnings.push({ message, fields });
        },
      },
      ...opts,
    }
  );
  const call = (entries = [entry], extra = {}) =>
    server.dispatchTestRequest(
      {
        method: 'tools/call',
        params: {
          name: 'sync_accounts',
          arguments: { accounts: entries, idempotency_key: randomUUID(), ...extra },
        },
      },
      { authInfo: { credential: { kind: 'api_key', key_id: 'buyer' } } }
    );
  return { server, call, diagnostics, warnings };
}

test('lookup is principal scoped, includes full natural key, and passes aligned existing snapshots without splitting the batch', async () => {
  const captures = [];
  const second = {
    ...entry,
    brand: { domain: 'other.example' },
    currency: 'EUR',
    timezone: 'Europe/Paris',
    operator_unit: { id: 'desk' },
  };
  const { call } = setup({
    resolve: async (ref, ctx) => {
      if (!ref) return null;
      captures.push({ ref, ctx });
      return ref.brand.domain === entry.brand.domain ? account : null;
    },
    upsert: async (refs, ctx) => {
      assert.equal(refs.length, 2);
      assert.deepEqual(ctx.existing, [account, null]);
      assert.equal(ctx.authInfo.credential.key_id, 'buyer');
      assert.notEqual(ctx.existing[0], account);
      return [
        row,
        {
          ...row,
          brand: second.brand,
          account_id: 'new',
          action: 'created',
          billing: 'agent',
          payment_terms: 'net_60',
        },
      ];
    },
  });
  const result = await call([entry, second]);
  assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
  assert.equal(captures.length, 3);
  assert.deepEqual(captures[0].ref, { brand: entry.brand, operator: entry.operator, sandbox: true });
  assert.equal(captures[0].ctx.provisioning, false);
  assert.equal(captures[0].ctx.toolName, 'sync_accounts');
  assert.equal(captures[1].ref.currency, 'EUR');
  assert.equal(result.structuredContent.accounts[0].billing, 'agent');
  assert.equal(result.structuredContent.accounts[0].payment_terms, 'net_60');
});

for (const violation of [{ account_id: 'new' }, { action: 'created' }]) {
  test(`identity violation ${JSON.stringify(violation)} warns by default and fails only in strict mode`, async () => {
    for (const strictIdempotency of [false, true]) {
      const source = Object.freeze({ ...row, billing: 'agent', payment_terms: 'net_60', ...violation });
      const { call, diagnostics, warnings } = setup({
        strictIdempotency,
        resolve: async () => account,
        upsert: async () => [source],
      });
      const result = await call();
      assert.equal(result.structuredContent.accounts[0].action, strictIdempotency ? 'failed' : source.action);
      if (strictIdempotency) assert.equal(result.structuredContent.accounts[0].errors[0].code, 'SYNC_FAILED');
      assert.equal(diagnostics[0].code, 'ACCOUNT_IDEMPOTENCY_VIOLATION');
      assert.equal(warnings[0].fields.index, 0);
      assert.equal(JSON.stringify(warnings).includes('acct_1'), false);
    }
  });
}

test('active terms mismatch or missing terms becomes PAYMENT_TERMS_NOT_SUPPORTED in strict mode', async () => {
  for (const payment_terms of ['net_30', undefined]) {
    const { call, diagnostics } = setup({
      strictIdempotency: true,
      resolve: async () => null,
      upsert: async () => [{ ...row, action: 'created', billing: 'agent', payment_terms }],
    });
    const result = await call();
    assert.equal(result.structuredContent.accounts[0].action, 'failed');
    assert.equal(result.structuredContent.accounts[0].errors[0].code, 'PAYMENT_TERMS_NOT_SUPPORTED');
    assert.ok(diagnostics.some(d => d.code === 'PAYMENT_TERMS_MISMATCH'));
  }
});

test('pending approval/rejected/failed rows do not trigger active payment-term failures', async () => {
  for (const status of ['pending_approval', 'rejected']) {
    const { call, diagnostics } = setup({
      strictIdempotency: true,
      resolve: async () => null,
      upsert: async () => [{ ...row, status, action: 'created', billing: 'agent', payment_terms: 'net_30' }],
    });
    const result = await call();
    assert.equal(result.structuredContent.accounts[0].status, status);
    assert.deepEqual(diagnostics, []);
  }
});

test('existing snapshot cannot be rewritten by the adopter to hide an identity violation', async () => {
  const { call } = setup({
    strictIdempotency: true,
    resolve: async () => account,
    upsert: async (_refs, ctx) => {
      ctx.existing[0].id = 'new';
      return [{ ...row, account_id: 'new' }];
    },
  });
  assert.equal((await call()).structuredContent.accounts[0].action, 'failed');
  assert.equal(account.id, 'acct_1');
});

test('lookup not found permits creation; other lookup errors stop writes', async () => {
  let writes = 0;
  const { call } = setup({
    resolve: async () => {
      throw new AccountNotFoundError();
    },
    upsert: async () => {
      writes++;
      return [{ ...row, action: 'created' }];
    },
  });
  await call();
  assert.equal(writes, 1);
  const unavailable = setup({
    strictIdempotency: true,
    resolve: async () => {
      throw new Error('unavailable');
    },
    upsert: async () => {
      writes++;
      return [row];
    },
  });
  assert.equal((await unavailable.call()).isError, true);
  assert.equal(writes, 1);
});

test('indices remain aligned when commercial policy refuses an earlier entry', async () => {
  const { call, diagnostics } = setup({
    strictIdempotency: true,
    resolve: async () => account,
    upsert: async refs => {
      assert.equal(refs.length, 1);
      return [{ ...row, payment_terms: 'net_30' }];
    },
  });
  const result = await call([{ ...entry, billing: 'advertiser' }, entry]);
  assert.equal(result.structuredContent.accounts[0].action, 'failed');
  assert.equal(result.structuredContent.accounts[1].errors[0].field, 'accounts[1].payment_terms');
  assert.equal(diagnostics[0].index, 1);
});

test('idempotency replay skips the second upsert while a new key runs the natural-key guard', async () => {
  let existing = null;
  let writes = 0;
  const { call, diagnostics } = setup(
    {
      resolve: async () => existing,
      upsert: async () => {
        writes++;
        existing = account;
        return [{ ...row, action: 'created', billing: 'agent', payment_terms: 'net_60' }];
      },
    },
    { idempotency: createIdempotencyStore({ backend: memoryBackend() }), resolveIdempotencyPrincipal: () => 'buyer' }
  );
  const key = randomUUID();
  await call([entry], { idempotency_key: key });
  await call([entry], { idempotency_key: key });
  assert.equal(writes, 1);
  await call();
  assert.equal(writes, 2);
  assert.ok(diagnostics.some(d => d.code === 'ACCOUNT_IDEMPOTENCY_VIOLATION'));
});

test('list_accounts incomplete agent billing produces a typed diagnostic', async () => {
  const { server, diagnostics } = setup({
    resolve: async () => null,
    list: async () => ({ items: [{ ...account, payment_terms: undefined }], nextCursor: null }),
  });
  await server.dispatchTestRequest({ method: 'tools/call', params: { name: 'list_accounts', arguments: {} } });
  assert.deepEqual(diagnostics, [{ code: 'ACCOUNT_BILLING_INCOMPLETE', toolName: 'list_accounts', index: 0 }]);
});

test('throwing diagnostic hooks/loggers cannot turn a compatibility diagnostic into failure', async () => {
  const { call } = setup(
    {
      resolve: async () => account,
      upsert: async () => [{ ...row, action: 'created' }],
      onDiagnostic: async () => {
        throw new Error('secret');
      },
    },
    {
      logger: {
        warn() {
          throw new Error('secret');
        },
        debug() {},
        info() {},
        error() {},
      },
    }
  );
  assert.equal((await call()).structuredContent.accounts[0].action, 'created');
});

test('adopter mutations cannot rewrite the requested commercial contract or nested snapshots', async () => {
  const requested = { ...entry };
  const { call } = setup({
    strictIdempotency: true,
    resolve: async () => account,
    upsert: async (refs, ctx) => {
      ctx.existing[0].billing.invoicedTo = 'operator';
      ctx.existing[0].ctx_metadata.changed = true;
      refs[0].payment_terms = 'net_30';
      return [{ ...row, action: 'updated', billing: 'agent', payment_terms: 'net_30' }];
    },
  });
  assert.equal((await call([requested])).structuredContent.accounts[0].errors[0].code, 'PAYMENT_TERMS_NOT_SUPPORTED');
  assert.equal(account.billing.invoicedTo, 'agent');
  assert.deepEqual(account.ctx_metadata, {});
});

test('missing response terms come from a fresh post-write lookup, preserving changes and exposing remaps', async () => {
  for (const requestedTerms of ['net_30', 'net_60']) {
    let stored = account;
    const { call } = setup({
      strictIdempotency: true,
      resolve: async () => stored,
      upsert: async () => {
        stored = { ...account, payment_terms: 'net_30' };
        return [{ ...row, action: 'updated', billing: 'agent' }];
      },
    });
    const response = (await call([{ ...entry, payment_terms: requestedTerms }])).structuredContent.accounts[0];
    assert.equal(response.action, requestedTerms === 'net_30' ? 'updated' : 'failed');
    if (requestedTerms === 'net_30') assert.equal(response.payment_terms, 'net_30');
    else assert.equal(response.errors[0].code, 'PAYMENT_TERMS_NOT_SUPPORTED');
  }
});

test('compatibility mode warns on lookup failure and still dispatches the original batch', async () => {
  let writes = 0;
  const { call, diagnostics } = setup({
    resolve: async ref => {
      if (ref) throw new Error('unsupported lookup');
      return null;
    },
    upsert: async () => {
      writes++;
      return [{ ...row, billing: 'agent', payment_terms: 'net_60' }];
    },
  });
  assert.notEqual((await call()).isError, true);
  assert.equal(writes, 1);
  assert.ok(diagnostics.some(d => d.code === 'ACCOUNT_LOOKUP_FAILED'));
});

test('combined identity and terms violations retain terminal identity failure', async () => {
  const { call, diagnostics } = setup({
    strictIdempotency: true,
    resolve: async () => account,
    upsert: async () => [
      { ...row, account_id: 'duplicate', action: 'created', billing: 'agent', payment_terms: 'net_30' },
    ],
  });
  const result = (await call()).structuredContent.accounts[0];
  assert.equal(result.errors[0].code, 'SYNC_FAILED');
  assert.equal(result.errors[0].recovery, 'terminal');
  assert.ok(diagnostics.some(d => d.code === 'PAYMENT_TERMS_MISMATCH'));
});

test('accepted operator payment terms can be completed from current stored state', async () => {
  const stored = { ...account, billing: { invoicedTo: 'operator' } };
  const { call } = setup({
    strictIdempotency: true,
    resolve: async () => stored,
    upsert: async () => [{ ...row, action: 'updated', billing: 'operator' }],
  });
  const result = (await call([{ ...entry, billing: 'operator' }])).structuredContent.accounts[0];
  assert.equal(result.action, 'updated');
  assert.equal(result.payment_terms, 'net_60');
});

test('dry-run omissions are neither completed from old terms nor falsely rejected', async () => {
  const { call } = setup({
    strictIdempotency: true,
    resolve: async () => account,
    upsert: async (_refs, ctx) => {
      ctx.input.dry_run = false;
      return [{ ...row, action: 'updated', billing: 'agent' }];
    },
  });
  const result = (await call([{ ...entry, payment_terms: 'net_30' }], { dry_run: true })).structuredContent;
  assert.equal(result.dry_run, true);
  assert.equal(result.accounts[0].action, 'updated');
  assert.equal(result.accounts[0].payment_terms, undefined);
});
