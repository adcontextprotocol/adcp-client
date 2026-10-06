const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server.js');
const { InMemoryStateStore } = require('../../dist/lib/server/state-store.js');
const { createIdempotencyStore, memoryBackend } = require('../../dist/lib/server/idempotency/index.js');
const { syncAccountsResponse } = require('../../dist/lib/server/responses.js');
const { validateResponse } = require('../../dist/lib/validation/schema-validator.js');

function entry(eventTypes = ['scheduled'], key = 'invalid') {
  return {
    brand: { domain: `${key}.example` },
    operator: 'buyer.example',
    billing: 'operator',
    notification_configs: [
      {
        subscriber_id: 'subscriber-1',
        url: 'https://buyer.example/notifications',
        event_types: eventTypes,
        authentication: { schemes: ['Bearer'], credentials: 'write-only-secret-for-notification-tests' },
      },
    ],
  };
}

function request(accounts = [entry()], overrides = {}) {
  return {
    adcp_version: '3.2',
    idempotency_key: 'notification-event-scope-0001',
    accounts,
    context: { correlation_id: 'event-scope-probe' },
    ...overrides,
  };
}

function fixture(t, overrides = {}, formatted = false, calls = []) {
  const idempotency = createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }) });
  const server = createAdcpServer({
    name: 'account-event-scope-test',
    version: '1.0.0',
    adcpVersion: '3.2.1',
    mcpToolProfile: 'all',
    idempotency,
    stateStore: new InMemoryStateStore(),
    resolveSessionKey: () => 'event-scope-principal',
    accounts: {
      syncAccounts: async params => {
        calls.push(structuredClone(params));
        const result = {
          ...(params.dry_run === true && { dry_run: true }),
          accounts: params.accounts.map(account => ({
            ...(account.account ? { account: account.account } : { brand: account.brand, operator: account.operator }),
            action: 'updated',
            status: 'active',
          })),
        };
        if (!formatted) return result;
        const response = syncAccountsResponse(result, 'Custom adopter guidance');
        return {
          ...response,
          content: [
            {
              type: 'text',
              text: formatted === 'json' ? JSON.stringify(response.structuredContent) : 'Custom adopter guidance',
            },
            { type: 'resource_link', uri: 'https://buyer.example/sync-report', name: 'Account sync report' },
          ],
          _meta: { source: 'account-handler' },
        };
      },
    },
    ...overrides,
  });
  t.after(() => server.close());
  const call = params =>
    server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'sync_accounts', arguments: params },
    });
  return { server, calls, call };
}

function assertRejected(response, index = 0, field = 'notification_configs[0].event_types[0]') {
  assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
  const body = response.structuredContent;
  assert.equal(body.adcp_error, undefined);
  const row = body.accounts[index];
  assert.equal(row.action, 'failed');
  if (row.account)
    assert.equal(row.status, undefined, 'failed settings updates must not invent an account lifecycle state');
  else assert.equal(row.status, 'rejected');
  assert.equal(row.errors[0].code, 'VALIDATION_ERROR');
  assert.equal(row.errors[0].field, field);
  assert.equal(row.notification_configs, undefined, 'rejected subscriptions must not be echoed');
  assert.ok(!JSON.stringify(response).includes('write-only-secret'));
  const outcome = validateResponse('sync_accounts', body, '3.2.1');
  assert.equal(outcome.valid, true, JSON.stringify(outcome.issues));
}

test('schema-invalid account event types return per-account failures without calling the handler', async t => {
  const { calls, call } = fixture(t);
  const args = request();
  const original = structuredClone(args);
  const response = await call(args);
  assertRejected(response);
  assert.deepEqual(response.structuredContent.context, args.context);
  assert.deepEqual(calls, []);
  assert.deepEqual(args, original);
  const replay = await call(args);
  assertRejected(replay);
  assert.equal(replay.structuredContent.replayed, true);
  assert.deepEqual(replay.structuredContent.accounts, response.structuredContent.accounts);
  assert.deepEqual(calls, []);
});

test('mixed batches reject every invalid account and preserve accepted row order', async t => {
  for (const formatted of [false, true, 'json']) {
    await t.test(`formatted handler: ${formatted}`, async t => {
      const { calls, call } = fixture(t, {}, formatted);
      const accounts = [
        entry(['product.updated'], 'first'),
        entry(),
        entry(['capabilities.changed'], 'caller-event'),
        entry(['signal.created'], 'last'),
      ];
      const response = await call(request(accounts, { dry_run: true }));
      assertRejected(response, 1);
      assertRejected(response, 2);
      assert.equal(response.structuredContent.dry_run, true);
      assert.deepEqual(
        response.structuredContent.accounts.map(row => row.brand.domain),
        ['first.example', 'invalid.example', 'caller-event.example', 'last.example']
      );
      assert.deepEqual(calls[0].accounts, [accounts[0], accounts[3]]);
      assert.equal(calls[0].dry_run, true);
      if (formatted) assert.deepEqual(response._meta, { source: 'account-handler' });
      if (formatted) assert.equal(response.content[1].uri, 'https://buyer.example/sync-report');
      if (formatted === true) assert.equal(response.content[0].text, 'Custom adopter guidance');
      if (formatted === 'json') assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
    });
  }
});

test('diagnostic limits preserve per-account failures beyond 100 invalid entries', async t => {
  const { call, calls } = fixture(t);
  const invalid = Array.from({ length: 150 }, (_, index) => entry(['scheduled'], `invalid-${index}`));
  const valid = entry(['product.updated'], 'valid-sibling');
  const response = await call(request([...invalid, valid]));
  assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
  assert.equal(response.structuredContent.accounts.length, 151);
  for (let index = 0; index < invalid.length; index++) {
    const row = response.structuredContent.accounts[index];
    assert.equal(row.brand.domain, invalid[index].brand.domain);
    assert.equal(row.action, 'failed');
    assert.equal(row.errors[0].code, 'VALIDATION_ERROR');
    assert.equal(row.errors[0].field, 'notification_configs[0].event_types[0]');
  }
  assert.equal(response.structuredContent.accounts[150].action, 'updated');
  assert.deepEqual(calls[0].accounts, [valid]);
});

test('settings-update account references and original event indexes survive rejection', async t => {
  const { call, calls } = fixture(t);
  const account = entry(['product.updated', 'scheduled', 'capabilities.changed']);
  delete account.brand;
  delete account.operator;
  delete account.billing;
  account.account = { account_id: 'account-existing' };
  const response = await call(request([account]));
  assertRejected(response, 0, 'notification_configs[0].event_types[1]');
  assert.deepEqual(response.structuredContent.accounts[0].account, account.account);
  assert.deepEqual(
    response.structuredContent.accounts[0].errors.map(error => error.field),
    ['notification_configs[0].event_types[1]', 'notification_configs[0].event_types[2]']
  );
  assert.deepEqual(calls, []);
});

test('replay caches the full mixed result and fingerprints rejected entries', async t => {
  const { call, calls } = fixture(t);
  const args = request([entry(), entry(['product.updated'], 'valid')]);
  const first = await call(args);
  assertRejected(first);
  const replay = await call(args);
  assertRejected(replay);
  assert.equal(replay.structuredContent.replayed, true);
  assert.deepEqual(replay.structuredContent.accounts, first.structuredContent.accounts);
  assert.equal(calls.length, 1);
  const conflict = await call(request([entry(['final']), args.accounts[1]]));
  assert.equal(conflict.structuredContent.adcp_error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(calls.length, 1);
});

test('other malformed request fields keep strict request-level rejection', async t => {
  for (const args of [
    request(undefined, { idempotency_key: 'bad' }),
    request(undefined, { accounts: {} }),
    request([{ ...entry(), billing: 'invalid' }]),
    request([{ ...entry(), notification_configs: [{ ...entry().notification_configs[0], event_types: [42] }] }]),
    request([{ ...entry(), notification_configs: [{ ...entry().notification_configs[0], url: 'invalid' }] }]),
  ]) {
    await t.test(JSON.stringify(args.accounts), async t => {
      const { call, calls } = fixture(t);
      const response = await call(args);
      assert.equal(response.structuredContent.adcp_error.code, 'VALIDATION_ERROR');
      assert.deepEqual(calls, []);
    });
  }
});

test('mixed batches preserve handler errors instead of manufacturing partial success', async t => {
  const { adcpError } = require('../../dist/lib/server/errors.js');
  const accepted = entry(['product.updated'], 'valid');
  const calls = [];
  const { call } = fixture(t, {
    accounts: {
      syncAccounts: async params => {
        calls.push(params.accounts);
        return adcpError('SERVICE_UNAVAILABLE', { message: 'Account writer is unavailable' });
      },
    },
  });
  const response = await call(request([entry(), accepted]));
  assert.equal(response.structuredContent.adcp_error.code, 'SERVICE_UNAVAILABLE');
  assert.equal(response.structuredContent.accounts, undefined);
  assert.deepEqual(calls, [[accepted]]);
});

test('mixed batches preserve preformatted protocol error arms', async t => {
  const errors = [{ code: 'PERMISSION_DENIED', message: 'Cannot sync this roster', recovery: 'terminal' }];
  const { call } = fixture(t, {
    accounts: { syncAccounts: async () => syncAccountsResponse({ errors }, 'Roster sync refused') },
  });
  const valid = entry(['product.updated'], 'valid');
  const baseline = await call(request([valid], { idempotency_key: 'notification-event-scope-error-baseline' }));
  const response = await call(request([entry(), valid]));
  assert.deepEqual(response.structuredContent, baseline.structuredContent);
  assert.deepEqual(response.structuredContent.errors, errors);
  assert.equal(response.content[0].text, 'Roster sync refused');
});

test('submitted tasks report rejected accounts immediately while retaining queued task handles', async t => {
  const accepted = entry(['product.updated'], 'valid');
  const calls = [];
  const { call } = fixture(t, {
    validation: { requests: 'strict', responses: 'strict' },
    accounts: {
      syncAccounts: async params => {
        calls.push(params.accounts);
        return { status: 'submitted', task_id: 'queued-account-sync', message: 'Account sync queued' };
      },
    },
  });
  const response = await call(request([entry(), accepted]));
  assert.equal(response.structuredContent.task_id, 'queued-account-sync');
  assert.equal(response.structuredContent.status, 'submitted');
  assert.equal(response.structuredContent.message, 'Account sync queued');
  assertRejected(response);
  assert.equal(response.structuredContent.accounts.length, 1);
  assert.match(response.content[0].text, /1 account rejected/);
  assert.deepEqual(calls, [[accepted]]);
  const replay = await call(request([entry(), accepted]));
  assert.equal(replay.structuredContent.task_id, 'queued-account-sync');
  assert.equal(replay.structuredContent.status, 'submitted');
  assert.equal(replay.structuredContent.replayed, true);
  assert.deepEqual(replay.structuredContent.accounts, response.structuredContent.accounts);
  assert.deepEqual(calls, [[accepted]]);
});

test('default text summaries surface account rejections for agent buyers', async t => {
  for (const accounts of [[entry()], [entry(), entry(['product.updated'], 'valid')]]) {
    await t.test(`${accounts.length} requested accounts`, async t => {
      const { call } = fixture(t);
      const response = await call(request(accounts));
      assertRejected(response);
      assert.match(response.content[0].text, /1 account rejected/);
      assert.match(response.content[0].text, new RegExp(`Synced ${accounts.length - 1} account`));
    });
  }
});

test('submitted formatted responses preserve partial handler rows, resources, and JSON mirrors', async t => {
  const accepted = entry(['product.updated'], 'valid');
  const completedRow = { brand: accepted.brand, operator: accepted.operator, action: 'updated', status: 'active' };
  const body = {
    status: 'submitted',
    task_id: 'partly-completed-account-sync',
    accounts: [completedRow],
  };
  const resource = { type: 'resource_link', uri: 'https://buyer.example/sync-report', name: 'Sync report' };
  const cached = {
    structuredContent: body,
    content: [{ type: 'text', text: JSON.stringify(body) }, resource],
    _meta: { source: 'adopter' },
  };
  const snapshot = structuredClone(cached);
  const { call } = fixture(t, { accounts: { syncAccounts: async () => cached } });
  const response = await call(request([entry(), accepted, entry(['product.updated'], 'pending')]));
  assert.equal(response.structuredContent.status, 'submitted');
  assert.equal(response.structuredContent.task_id, body.task_id);
  assert.deepEqual(response.structuredContent.accounts[0], completedRow);
  assertRejected(response, 1);
  assert.equal(response.structuredContent.accounts.length, 2);
  assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
  assert.deepEqual(response.content[1], resource);
  assert.deepEqual(response._meta, cached._meta);
  assert.deepEqual(cached, snapshot);
});

test('wrong handler row counts fence committed siblings instead of allowing re-execution', async t => {
  let calls = 0;
  const { call } = fixture(t, {
    accounts: {
      syncAccounts: async () => {
        calls += 1;
        return { accounts: [] };
      },
    },
  });
  const args = request([entry(), entry(['product.updated'], 'valid')]);
  const response = await call(args);
  assert.equal(response.structuredContent.adcp_error.code, 'SERVICE_UNAVAILABLE');
  assert.match(response.structuredContent.adcp_error.message, /reconcile/i);
  const retry = await call(args);
  assert.equal(retry.structuredContent.adcp_error.code, 'IDEMPOTENCY_IN_FLIGHT');
  assert.equal(calls, 1);
});

test('submitted handlers cannot hide malformed account results behind synthetic failures', async t => {
  let calls = 0;
  const { call } = fixture(t, {
    accounts: {
      syncAccounts: async () => {
        calls += 1;
        return { status: 'submitted', task_id: 'malformed-account-sync', accounts: { invalid: true } };
      },
    },
  });
  const args = request([entry(), entry(['product.updated'], 'valid')]);
  const response = await call(args);
  assert.equal(response.structuredContent.adcp_error.code, 'SERVICE_UNAVAILABLE');
  const retry = await call(args);
  assert.equal(retry.structuredContent.adcp_error.code, 'IDEMPOTENCY_IN_FLIGHT');
  assert.equal(calls, 1);
});

test('platform commercial failure pointers retain original account indices after event rejection', async t => {
  const { createAdcpServerFromPlatform } = require('../../dist/lib/server/decisioning/runtime/from-platform.js');
  const captures = [];
  const platform = {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      supportedBillings: ['operator'],
      supportedPaymentTerms: ['net_30'],
      config: {},
    },
    accounts: {
      resolve: async () => null,
      upsert: async refs => {
        captures.push(refs);
        return refs.map(ref => ({ brand: ref.brand, operator: ref.operator, action: 'created', status: 'active' }));
      },
      list: async () => ({ items: [], nextCursor: null }),
    },
    statusMappers: {},
    sales: {
      getProducts: async () => ({ cache_scope: 'account', products: [] }),
      createMediaBuy: async () => ({ media_buy_id: 'unused' }),
      updateMediaBuy: async () => ({ media_buy_id: 'unused' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({ media_buys: [] }),
    },
  };
  const server = createAdcpServerFromPlatform(platform, {
    name: 'event-commercial-gate-test',
    version: '1.0.0',
    adcpVersion: '3.2.1',
    validation: { requests: 'strict', responses: 'strict' },
  });
  t.after(() => server.close());
  const valid = entry(['product.updated'], 'valid');
  const commercialFailure = { ...entry(['product.updated'], 'commercial'), payment_terms: 'net_60' };
  const response = await server.dispatchTestRequest({
    method: 'tools/call',
    params: { name: 'sync_accounts', arguments: request([entry(), valid, commercialFailure]) },
  });
  assertRejected(response);
  const commercial = response.structuredContent.accounts[2];
  assert.equal(commercial.action, 'failed');
  assert.equal(commercial.errors[0].code, 'PAYMENT_TERMS_NOT_SUPPORTED');
  assert.equal(commercial.errors[0].field, 'accounts[2].payment_terms');
  assert.equal(captures.length, 1);
  assert.equal(captures[0].length, 1);
  assert.deepEqual(captures[0][0].brand, valid.brand);
  const opaqueError = await server.dispatchTestRequest({
    method: 'tools/call',
    params: {
      name: 'sync_accounts',
      arguments: request([entry(), { account: { account_id: 'existing-account' }, payment_terms: 'net_60' }], {
        idempotency_key: 'notification-event-scope-opaque-commercial',
      }),
    },
  });
  assert.equal(opaqueError.structuredContent.adcp_error.code, 'PAYMENT_TERMS_NOT_SUPPORTED');
  assert.equal(opaqueError.structuredContent.adcp_error.field, 'accounts[1].payment_terms');
  assert.equal(captures.length, 1, 'opaque commercial failure must not reach the writer');
});

test('returned and thrown handler error diagnostics retain original indices across retries', async t => {
  const { adcpError } = require('../../dist/lib/server/errors.js');
  for (const scenario of ['returned', 'thrown', 'issues only']) {
    await t.test(scenario, async t => {
      let calls = 0;
      const issues = [{ pointer: '/accounts/0/account', message: 'Invalid account setting', keyword: 'required' }];
      const envelope = adcpError('VALIDATION_ERROR', {
        message: 'Cannot update this account',
        ...(scenario !== 'issues only' && { field: 'accounts[0].account' }),
        issues,
        details: { issues },
      });
      const snapshot = structuredClone(envelope);
      const { call } = fixture(t, {
        accounts: {
          syncAccounts: async () => {
            calls += 1;
            if (scenario === 'thrown') throw envelope;
            return envelope;
          },
        },
      });
      const args = request([entry(), entry(['product.updated'], 'valid')]);
      const response = await call(args);
      assert.equal(response.structuredContent.adcp_error.code, 'VALIDATION_ERROR');
      if (scenario !== 'issues only') assert.equal(response.structuredContent.adcp_error.field, 'accounts[1].account');
      assert.equal(response.structuredContent.adcp_error.issues[0].pointer, '/accounts/1/account');
      assert.equal(response.structuredContent.adcp_error.details.issues[0].pointer, '/accounts/1/account');
      const replay = await call(args);
      assert.deepEqual(replay.structuredContent.adcp_error, response.structuredContent.adcp_error);
      // Returned operation errors reexecute; stable thrown errors replay.
      // Error-envelope replay does not carry the success replay marker.
      assert.equal(calls, scenario === 'thrown' ? 1 : 2);
      assert.deepEqual(envelope, snapshot);
    });
  }
});

test('merging into a cached frozen response keeps each request JSON mirror isolated', async t => {
  const valid = entry(['product.updated'], 'valid');
  const cached = syncAccountsResponse({
    accounts: [{ brand: valid.brand, operator: valid.operator, action: 'updated', status: 'active' }],
  });
  cached.content = [{ type: 'text', text: JSON.stringify(cached.structuredContent) }];
  const snapshot = structuredClone(cached);
  Object.freeze(cached.content[0]);
  Object.freeze(cached.content);
  Object.freeze(cached.structuredContent);
  Object.freeze(cached);
  const { call } = fixture(t, { accounts: { syncAccounts: async () => cached } });
  for (const key of ['first-rejected', 'second-rejected']) {
    const response = await call(
      request([entry(['scheduled'], key), valid], {
        idempotency_key: `notification-event-scope-${key}`,
      })
    );
    assertRejected(response);
    assert.deepEqual(
      response.structuredContent.accounts.map(row => row.brand.domain),
      [`${key}.example`, 'valid.example']
    );
    assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
    assert.deepEqual(cached, snapshot);
  }
});

test('replacement rosters with invalid events refuse every row without deactivating existing accounts', async t => {
  for (const dryRun of [false, true]) {
    await t.test(`dry_run: ${dryRun}`, async t => {
      const active = new Set(['invalid.example', 'valid.example', 'omitted.example']);
      let handlerCalls = 0;
      const { call } = fixture(t, {
        accounts: {
          syncAccounts: async params => {
            handlerCalls++;
            const requested = new Set(params.accounts.map(account => account.brand.domain));
            if (params.delete_missing && !params.dry_run) {
              for (const domain of active) if (!requested.has(domain)) active.delete(domain);
            }
            return {
              accounts: params.accounts.map(account => ({
                brand: account.brand,
                operator: account.operator,
                action: 'updated',
                status: 'active',
              })),
            };
          },
        },
      });
      const response = await call(
        request([entry(), entry(['product.updated'], 'valid')], {
          delete_missing: true,
          dry_run: dryRun,
        })
      );
      assertRejected(response);
      assertRejected(response, 1, 'delete_missing');
      assert.equal(handlerCalls, 0);
      assert.deepEqual([...active], ['invalid.example', 'valid.example', 'omitted.example']);
      assert.equal(response.structuredContent.dry_run === true, dryRun);
      const corrected = await call(
        request([entry(['product.updated'], 'invalid'), entry(['product.updated'], 'valid')], {
          delete_missing: true,
          dry_run: dryRun,
          idempotency_key: 'notification-event-scope-corrected',
        })
      );
      assert.equal(corrected.structuredContent.adcp_error, undefined);
      assert.equal(handlerCalls, 1);
      assert.deepEqual(
        [...active],
        dryRun ? ['invalid.example', 'valid.example', 'omitted.example'] : ['invalid.example', 'valid.example']
      );
    });
  }
});

test('validation off on unforced dispatch retains handler-owned account validation', async t => {
  const { call, calls } = fixture(t, { validation: { requests: 'off', responses: 'strict' } });
  const args = request();
  const response = await call(args);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].accounts, args.accounts);
  assert.equal(response.structuredContent.accounts[0].action, 'updated');
});

test('warn validation keeps 14.0 advisory dispatch for event-type and other schema failures', async t => {
  const warnings = [];
  const logger = { debug() {}, info() {}, warn: (message, meta) => warnings.push({ message, meta }), error() {} };
  const { call, calls } = fixture(t, { logger, validation: { requests: 'warn', responses: 'strict' } });
  const invalid = entry();
  const valid = entry(['product.updated'], 'valid');
  const response = await call(request([invalid, valid]));
  assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
  assert.deepEqual(calls[0].accounts, [invalid, valid]);
  assert.deepEqual(
    response.structuredContent.accounts.map(row => row.action),
    ['updated', 'updated']
  );
  assert.ok(warnings.some(entry => /Schema validation warning \(request\) for sync_accounts/.test(entry.message)));
  const malformed = { ...entry(), billing: 'invalid' };
  const advisory = await call(request([malformed], { idempotency_key: 'notification-event-scope-warn-malformed' }));
  assert.equal(advisory.structuredContent.accounts[0].action, 'updated');
  assert.deepEqual(calls[1].accounts, [malformed]);
});

test('legacy response schemas keep opaque failure identities on the strict request path before writes', async t => {
  for (const deleteMissing of [false, true]) {
    await t.test(`delete_missing: ${deleteMissing}`, async t => {
      const { call, calls } = fixture(t, {
        adcpVersion: '3.1.24',
        validation: { requests: 'strict', responses: 'strict' },
      });
      const opaque = {
        account: { account_id: 'legacy-existing' },
        notification_configs: entry(['account.status_changed']).notification_configs,
      };
      // A replacement roster also refuses valid settings-update peers, so
      // their failure identities must be checked before applying that policy.
      const accounts = deleteMissing
        ? [
            entry(['account.status_changed']),
            { ...opaque, notification_configs: entry(['product.updated']).notification_configs },
          ]
        : [opaque, entry(['product.updated'], 'valid')];
      const response = await call(request(accounts, { adcp_version: '3.1', delete_missing: deleteMissing }));
      assert.equal(response.structuredContent.adcp_error.code, 'VALIDATION_ERROR');
      assert.deepEqual(calls, []);
    });
  }
});

test('legacy provisioning identities still produce schema-valid per-account event failures', async t => {
  const { call, calls } = fixture(t, {
    adcpVersion: '3.1.24',
    validation: { requests: 'strict', responses: 'strict' },
  });
  const response = await call(
    request([entry(['account.status_changed']), entry(['product.updated'], 'valid')], { adcp_version: '3.1' })
  );
  assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
  assert.equal(response.structuredContent.accounts[0].action, 'failed');
  assert.equal(response.structuredContent.accounts[0].errors[0].field, 'notification_configs[0].event_types[0]');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].accounts.length, 1);
  const outcome = validateResponse('sync_accounts', response.structuredContent, '3.1.24');
  assert.equal(outcome.valid, true, JSON.stringify(outcome.issues));
});

for (const protocolVersion of ['2026-07-28', '2025-11-25']) {
  test(`MCP ${protocolVersion} returns the storyboard's per-account rejection with strict validation`, async t => {
    const { serve } = require('../../dist/lib/index.js');
    const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
    const calls = [];
    const httpServer = serve(
      () =>
        fixture(
          t,
          {
            validation: { requests: protocolVersion === '2026-07-28' ? 'off' : 'strict', responses: 'strict' },
          },
          false,
          calls
        ).server,
      { port: 0, onListening: () => {} }
    );
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      if (httpServer.listening) resolve();
      else httpServer.once('listening', resolve);
    });
    const client = new Client(
      { name: 'event-scope-client', version: '1.0.0' },
      { versionNegotiation: { mode: protocolVersion === '2026-07-28' ? { pin: protocolVersion } : 'legacy' } }
    );
    t.after(async () => {
      await client.close();
      await new Promise((resolve, reject) => httpServer.close(error => (error ? reject(error) : resolve())));
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpServer.address().port}/mcp`))
    );
    const args = request();
    const response = await client.callTool({ name: 'sync_accounts', arguments: args });
    assertRejected(response);
    assert.deepEqual(response.structuredContent.context, args.context);
    assert.deepEqual(calls, []);
  });
}
