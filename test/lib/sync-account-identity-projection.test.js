const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toWireSyncAccountRow } = require('../../dist/lib/server/decisioning/account.js');
const { syncAccountsResponse } = require('../../dist/lib/server/responses.js');
const { getSchemaValidatorByRef } = require('../../dist/lib/schemas');
const { createAdcpServerFromPlatform } = require('../../dist/lib/server/decisioning/runtime/from-platform.js');
const { ADCP_VERSION } = require('../../dist/lib/version.js');
const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server.js');
const { createIdempotencyStore, memoryBackend } = require('../../dist/lib/server/idempotency');

function identityRow(preview = false) {
  const requested = { operator: 'destination.example', operator_unit: { id: 'destination-seat' } };
  return {
    account_id: 'account-3466',
    account: { account_id: 'account-3466' },
    operator_unit: { id: 'current-seat', name: 'Current buying desk' },
    revision: 3,
    currency: 'EUR',
    timezone: 'Europe/Berlin',
    action: 'updated',
    status: 'active',
    ...(preview
      ? {
          identity_change_preview: {
            outcome: 'would_require_approval',
            requested_operator_identity: requested,
            impacts: [{ area: 'billing', effect: 'revalidation_required' }],
          },
        }
      : {
          identity_change: {
            status: 'pending_approval',
            requested_operator_identity: requested,
            requested_at: '2026-10-27T00:00:00Z',
          },
        }),
  };
}

for (const version of ['3.2.7']) {
  for (const preview of [false, true]) {
    test(`${version}: sync account projection preserves identity and commercial fields (preview: ${preview})`, () => {
      const row = identityRow(preview);
      const snapshot = structuredClone(row);
      const wire = toWireSyncAccountRow(row);
      assert.deepEqual(wire, row);
      assert.deepEqual(row, snapshot);
      assert.equal(Object.hasOwn(wire, 'brand'), false);
      assert.equal(Object.hasOwn(wire, 'operator'), false);
      const validate = getSchemaValidatorByRef('account/sync-accounts-response.json', version);
      assert.equal(
        validate({ status: 'completed', accounts: [wire], ...(preview && { dry_run: true }) }),
        true,
        JSON.stringify(validate.errors)
      );
    });
  }
  test(`${version}: an unresolved settings-update failure needs no invented natural key or lifecycle status`, () => {
    const row = {
      account: { account_id: 'unreachable-account' },
      action: 'failed',
      errors: [{ code: 'ACCOUNT_NOT_FOUND', message: 'Account not found.' }],
    };
    const wire = toWireSyncAccountRow(row);
    assert.deepEqual(wire, row);
    const validate = getSchemaValidatorByRef('account/sync-accounts-response.json', version);
    assert.equal(validate({ status: 'completed', accounts: [wire] }), true, JSON.stringify(validate.errors));
  });
}

test('sync account projection preserves the provisioning identity anchor and falsy values without rewriting them', () => {
  const { account: _account, ...row } = identityRow();
  const provisioning = { ...row, brand: { domain: 'brand.example' }, operator: 'current.example', revision: 0 };
  assert.deepEqual(toWireSyncAccountRow(provisioning), provisioning);
});

test('projector and raw response builder strip all destination staging data and current bank details', () => {
  const row = {
    ...identityRow(),
    billing_entity: {
      legal_name: 'Current Agency GmbH',
      bank: { account_holder: 'Current Agency GmbH', iban: 'DE89370400440532013000' },
    },
    destination_billing_entity: {
      legal_name: 'Confidential Destination GmbH',
      tax_id: 'destination-tax-must-not-echo',
      bank: { account_number: 'destination-bank-must-not-echo' },
    },
    authInfo: { token: 'internal-auth-must-not-echo' },
    ctx_metadata: { secret: 'internal-metadata-must-not-echo' },
  };
  const before = structuredClone(row);
  const projected = toWireSyncAccountRow(row);
  const rawRow = { ...row };
  const response = syncAccountsResponse({ accounts: [rawRow] });
  for (const wire of [projected, response.structuredContent.accounts[0]]) {
    assert.equal(Object.hasOwn(wire, 'destination_billing_entity'), false);
    assert.deepEqual(wire.billing_entity, { legal_name: 'Current Agency GmbH' });
    for (const field of ['account', 'operator_unit', 'revision', 'identity_change', 'currency', 'timezone']) {
      assert.deepEqual(wire[field], row[field], field);
    }
    assert.ok(!JSON.stringify(wire).includes('must-not-echo'));
  }
  assert.ok(!JSON.stringify(response).includes('Confidential Destination'));
  assert.deepEqual(row, before, 'projection must not modify the stored account or its write-only data');
});

for (const version of ['3.2']) {
  for (const preview of [false, true]) {
    for (const kind of ['platform', 'direct']) {
      test(`${version}: ${kind} sync_accounts preserves identity on initial response and replay (preview: ${preview})`, async t => {
        const row = {
          ...identityRow(preview),
          destination_billing_entity: { legal_name: 'Confidential Destination GmbH' },
          billing_entity: { legal_name: 'Current Agency GmbH', bank: { account_number: 'bank-must-not-echo' } },
        };
        let upsertCalls = 0;
        const options = {
          name: 'sync-identity-projection',
          version: '1',
          idempotency: createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }), ttlSeconds: 86400 }),
          resolveIdempotencyPrincipal: () => 'trusted-test-buyer',
          validation: { requests: 'strict', responses: 'strict' },
        };
        const server =
          kind === 'direct'
            ? createAdcpServer({
                ...options,
                accounts: {
                  syncAccounts: async () => {
                    upsertCalls++;
                    return { accounts: [row], ...(preview && { dry_run: true }) };
                  },
                },
              })
            : createAdcpServerFromPlatform(
                {
                  capabilities: {
                    specialisms: ['sales-non-guaranteed'],
                    creative_agents: [],
                    channels: ['display'],
                    pricingModels: ['cpm'],
                    config: {},
                  },
                  sales: {},
                  accounts: {
                    resolve: async () => ({
                      id: row.account_id,
                      name: 'Seller account',
                      status: 'active',
                      ctx_metadata: {},
                    }),
                    upsert: async () => {
                      upsertCalls++;
                      return [row];
                    },
                  },
                },
                options
              );
        t.after(() => server.close());
        const request = {
          method: 'tools/call',
          params: {
            name: 'sync_accounts',
            arguments: {
              adcp_version: version,
              idempotency_key: 'account-identity-projection-3466',
              accounts: [{ account: row.account, name: 'Seller account' }],
              ...(preview && { dry_run: true }),
            },
          },
        };
        const expected = toWireSyncAccountRow(row);
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = await server.dispatchTestRequest(structuredClone(request));
          assert.equal(response.isError, undefined, JSON.stringify(response));
          assert.deepEqual(response.structuredContent.accounts, [expected]);
          assert.equal(response.structuredContent.dry_run, preview || undefined);
          if (attempt === 1) assert.equal(response.structuredContent.replayed, true);
          assert.ok(!JSON.stringify(response).includes('Confidential Destination'));
          assert.ok(!JSON.stringify(response).includes('bank-must-not-echo'));
        }
        assert.equal(upsertCalls, 1, 'an idempotent replay returns the already sanitized response');
      });
    }
  }
}

for (const version of ['3.0', '3.1']) {
  test(`${version}: existing provisioning rows retain their required identity and lifecycle fields`, () => {
    const row = {
      brand: { domain: 'brand.example' },
      operator: 'agency.example',
      action: 'unchanged',
      status: 'active',
    };
    const wire = toWireSyncAccountRow(row);
    assert.deepEqual(wire, row);
    const validate = getSchemaValidatorByRef('account/sync-accounts-response.json', version);
    assert.equal(validate({ status: 'completed', accounts: [wire] }), true, JSON.stringify(validate.errors));
  });
}

test('nested identity objects cannot retain write-only or internal data even with response validation disabled', () => {
  const row = identityRow();
  const dirtyRows = [
    { ...row, account: { ...row.account, ctx_metadata: { token: 'must-not-echo' } } },
    { ...row, account: { ...row.account, destination_billing_entity: { legal_name: 'must-not-echo' } } },
    { ...row, operator_unit: { ...row.operator_unit, credentials: 'must-not-echo' } },
    {
      ...row,
      identity_change: {
        ...row.identity_change,
        requested_operator_identity: {
          operator: 'destination.example',
          destination_billing_entity: { legal_name: 'must-not-echo' },
        },
      },
    },
    {
      ...identityRow(true),
      identity_change_preview: { ...identityRow(true).identity_change_preview, authInfo: { token: 'must-not-echo' } },
    },
  ];
  for (const dirty of dirtyRows) {
    for (const emit of [value => toWireSyncAccountRow(value), value => syncAccountsResponse({ accounts: [value] })]) {
      assert.throws(
        () => emit(dirty),
        error => {
          assert.match(error.message, /canonical identity schema/);
          assert.ok(!error.message.includes('must-not-echo'));
          return true;
        }
      );
    }
  }
});

test('strict commercial-contract failures preserve a settings-update account anchor', async () => {
  const { checkSyncAccountRows } = require('../../dist/lib/server/account-sync-contract.js');
  const row = { ...identityRow(), billing: 'operator', payment_terms: 'net_60' };
  const results = await checkSyncAccountRows(
    { strictIdempotency: true, resolve: async () => null },
    [{ account: row.account, billing: 'agent' }],
    [null],
    [row],
    [0],
    {},
    { debug() {}, info() {}, warn() {}, error() {} }
  );
  assert.equal(results[0].action, 'failed');
  assert.deepEqual(results[0].account, row.account);
  const wire = toWireSyncAccountRow(results[0], '3.2');
  assert.equal(Object.hasOwn(wire, 'brand'), false);
  assert.equal(Object.hasOwn(wire, 'operator'), false);
  const validate = getSchemaValidatorByRef('account/sync-accounts-response.json', '3.2');
  assert.equal(validate({ status: 'completed', accounts: [wire] }), true, JSON.stringify(validate.errors));
});

test('validated identity snapshots do not change when the adopter later mutates its account record', () => {
  const row = identityRow();
  const before = structuredClone(row);
  const projected = toWireSyncAccountRow(row);
  const raw = syncAccountsResponse({ accounts: [row] }).structuredContent.accounts[0];
  row.account.account_id = 'changed-after-emission';
  row.operator_unit.name = 'changed-after-emission';
  row.identity_change.requested_operator_identity.credentials = 'changed-after-emission';
  for (const result of [projected, raw]) {
    assert.deepEqual(result, before);
    assert.ok(!JSON.stringify(result).includes('changed-after-emission'));
  }
});

for (const kind of ['platform', 'direct']) {
  test(`${kind}: rejected nested identity data cannot leak or re-execute a committed sync when validation is off`, async t => {
    let calls = 0;
    const row = identityRow();
    row.account.ctx_metadata = { token: 'NEVER-EXPOSE-3466' };
    const options = {
      name: 'invalid-account-identity',
      version: '1',
      idempotency: createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }), ttlSeconds: 86400 }),
      resolveIdempotencyPrincipal: () => 'trusted-test-buyer',
      validation: { requests: 'off', responses: 'off' },
    };
    const server =
      kind === 'direct'
        ? createAdcpServer({
            ...options,
            accounts: {
              syncAccounts: async () => {
                calls++;
                return { accounts: [row] };
              },
            },
          })
        : createAdcpServerFromPlatform(
            {
              capabilities: {
                specialisms: ['sales-non-guaranteed'],
                channels: ['display'],
                pricingModels: ['cpm'],
                config: {},
              },
              sales: {},
              accounts: {
                resolve: async () => null,
                upsert: async () => {
                  calls++;
                  return [row];
                },
              },
            },
            options
          );
    t.after(() => server.close());
    const request = {
      method: 'tools/call',
      params: {
        name: 'sync_accounts',
        arguments: {
          adcp_version: '3.2',
          idempotency_key: 'invalid-identity-projection-3466',
          accounts: [{ account: { account_id: 'account-3466' } }],
        },
      },
    };
    const first = await server.dispatchTestRequest(structuredClone(request));
    const retry = await server.dispatchTestRequest(structuredClone(request));
    assert.equal(first.structuredContent.adcp_error.code, 'SERVICE_UNAVAILABLE');
    assert.equal(retry.structuredContent.adcp_error.code, 'IDEMPOTENCY_IN_FLIGHT');
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify([first, retry]).includes('NEVER-EXPOSE-3466'));
  });
}

test('published server declarations support typed account-anchored upsert results', () => {
  const { spawnSync } = require('node:child_process');
  const { resolve } = require('node:path');
  const compiled = spawnSync(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--strict',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--skipLibCheck',
      'test/fixtures/types/sync-account-stable.mts',
    ],
    { cwd: resolve(__dirname, '../..'), encoding: 'utf8', timeout: 30000 }
  );
  assert.equal(compiled.status, 0, compiled.stdout || compiled.stderr || String(compiled.error));
});

test('stable result rows select the identity anchor at the served release without changing the legacy interface', () => {
  const row = { ...identityRow(), brand: { domain: 'brand.example' }, operator: 'agency.example' };
  for (const version of ['3.0', '3.1', '3.2']) {
    const wire = toWireSyncAccountRow(row, version);
    assert.equal(Object.hasOwn(wire, 'account'), version === '3.2');
    assert.equal(Object.hasOwn(wire, 'brand'), version !== '3.2');
    assert.equal(Object.hasOwn(wire, 'operator'), version !== '3.2');
    const validate = getSchemaValidatorByRef('account/sync-accounts-response.json', version);
    assert.equal(validate({ status: 'completed', accounts: [wire] }), true, JSON.stringify(validate.errors));
  }
});
