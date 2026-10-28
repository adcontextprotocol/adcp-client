const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { toWireSyncAccountRow } = require('../../dist/lib/server/decisioning/account.js');
const { syncAccountsResponse } = require('../../dist/lib/server/responses.js');
const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server.js');
const { createAdcpServerFromPlatform } = require('../../dist/lib/server/decisioning/runtime/from-platform.js');
const { createIdempotencyStore, memoryBackend } = require('../../dist/lib/server/idempotency');
const {
  getSchemaDocumentByRef,
  getSchemaValidatorByRef,
  toReleasePrecisionWire,
} = require('../../dist/lib/validation/schema-loader.js');
const { ADCP_VERSION } = require('../../dist/lib/version.js');

const schema = getSchemaDocumentByRef('account/sync-accounts-response.json').schema;
const fields = schema.oneOf.find(branch => branch.title === 'SyncAccountsSuccess').properties.accounts.items.properties;
const ownsRequests = Object.hasOwn(fields, 'request_id') && Object.hasOwn(fields, 'resolution');

test(`${ADCP_VERSION}: public account result types track the installed protocol bundle`, () => {
  const root = path.resolve(__dirname, '../..');
  const scratch = path.join(root, '.context');
  fs.mkdirSync(scratch, { recursive: true });
  const directory = fs.mkdtempSync(path.join(scratch, 'account-request-types-'));
  const base = `({ brand: { domain: 'acme.example' }, operator: 'pinnacle.example', action: 'unchanged', status: 'pending_approval' } as const)`;
  const source = ownsRequests
    ? `import type { AccountStore, SyncAccountsResultRow } from '@adcp/sdk/server';
       export const pending = { ...${base}, request_id: 'areq_pending' } satisfies SyncAccountsResultRow;
       export const resolved = { ...${base}, status: 'active', account_id: 'account_confirmed', resolution: 'matched' } satisfies SyncAccountsResultRow;
       export const upsert: NonNullable<AccountStore['upsert']> = async () => [pending, resolved];
       // @ts-expect-error A resolution is a schema-defined string, never an arbitrary object/number.
       export const invalid = { ...resolved, resolution: 123 } satisfies SyncAccountsResultRow;`
    : `import type { SyncAccountsResultRow } from '@adcp/sdk/server';
       export const pending = ${base} satisfies SyncAccountsResultRow;
       declare const row: SyncAccountsResultRow;
       // @ts-expect-error beta.0 does not declare account-request result identifiers.
       row.request_id;
       // @ts-expect-error beta.0 does not declare account-request resolutions.
       row.resolution;`;
  fs.writeFileSync(path.join(directory, 'adopter.mts'), source);
  fs.writeFileSync(
    path.join(directory, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        skipLibCheck: true,
        declaration: true,
        emitDeclarationOnly: true,
        rootDir: root,
        outDir: './out',
      },
      files: ['./adopter.mts'],
    })
  );
  try {
    execFileSync(
      process.execPath,
      [path.join(root, 'node_modules/typescript/bin/tsc'), '--project', path.join(directory, 'tsconfig.json')],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function requestRow(state) {
  const identity = { brand: { domain: 'acme.example' }, operator: 'pinnacle.example' };
  if (state === 'pending') {
    return {
      ...identity,
      action: 'unchanged',
      status: 'pending_approval',
      request_id: 'areq_pending',
      setup: { message: 'Seller review is pending.', url: 'https://seller.example/account-review' },
    };
  }
  return {
    ...identity,
    account_id: 'account_confirmed',
    action: state === 'created' ? 'created' : 'unchanged',
    status: 'active',
    resolution: state,
  };
}

function expectedRow(row, includeRequests) {
  const { request_id, resolution, ...legacy } = row;
  return includeRequests
    ? { ...legacy, ...(request_id !== undefined && { request_id }), ...(resolution !== undefined && { resolution }) }
    : legacy;
}

for (const state of ['pending', 'matched', 'created']) {
  test(`${ADCP_VERSION}: project ${state} account requests only when declared by the source bundle`, () => {
    const row = requestRow(state);
    const dirty = {
      ...row,
      billing_entity: { legal_name: 'Pinnacle Agency', bank: { account_number: 'bank-must-not-echo' } },
      destination_billing_entity: { legal_name: 'destination-must-not-echo' },
      authInfo: { token: 'auth-must-not-echo' },
      ctx_metadata: { secret: 'metadata-must-not-echo' },
    };
    const before = structuredClone(dirty);
    const expected = { ...expectedRow(row, ownsRequests), billing_entity: { legal_name: 'Pinnacle Agency' } };
    const validate = getSchemaValidatorByRef('account/sync-accounts-response.json');
    for (const wire of [
      toWireSyncAccountRow(dirty),
      syncAccountsResponse({ accounts: [dirty] }).structuredContent.accounts[0],
    ]) {
      assert.deepEqual(wire, expected);
      assert.equal(validate({ status: 'completed', accounts: [wire] }), true, JSON.stringify(validate.errors));
      assert.ok(!JSON.stringify(wire).includes('must-not-echo'));
      if (state === 'pending') assert.equal(Object.hasOwn(wire, 'account_id'), false, 'no provisional account ID');
    }
    assert.deepEqual(dirty, before);
  });
}

test('request result objects cannot carry internal data when their source fields are supported', () => {
  for (const [row, key] of [
    [requestRow('pending'), 'request_id'],
    [requestRow('matched'), 'resolution'],
  ]) {
    row[key] = { token: 'must-not-echo' };
    for (const emit of [toWireSyncAccountRow, value => syncAccountsResponse({ accounts: [value] })]) {
      if (ownsRequests) {
        assert.throws(
          () => emit(row),
          error => {
            assert.match(error.message, /Account request result .* must be a string/);
            assert.ok(!error.message.includes('must-not-echo'));
            return true;
          }
        );
      } else {
        assert.ok(!JSON.stringify(emit(row)).includes('must-not-echo'));
      }
    }
  }
});

for (const version of ['3.1', '3.2', toReleasePrecisionWire(ADCP_VERSION)]) {
  for (const kind of ['platform', 'direct']) {
    for (const state of ['pending', 'matched', 'created']) {
      test(`${version}: ${kind} ${state} sync result and replay preserve the served account lifecycle`, async t => {
        const row = requestRow(state);
        let writes = 0;
        const options = {
          name: 'account-request-projection',
          version: '1',
          capabilities: { supported_versions: ['3.1', '3.2', ADCP_VERSION] },
          idempotency: createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }), ttlSeconds: 86400 }),
          resolveIdempotencyPrincipal: () => 'buyer-account-request-projection',
          // Production defaults to response validation off. Projection must
          // still remove newer fields before sending a legacy response.
          validation: { requests: 'strict', responses: 'off' },
        };
        const handler = () => {
          writes++;
          return { ...row, ctx_metadata: { secret: 'must-not-echo' } };
        };
        const server =
          kind === 'direct'
            ? createAdcpServer({ ...options, accounts: { syncAccounts: async () => ({ accounts: [handler()] }) } })
            : createAdcpServerFromPlatform(
                {
                  capabilities: {
                    specialisms: ['sales-non-guaranteed'],
                    creative_agents: [],
                    channels: ['display'],
                    pricingModels: ['cpm'],
                    supportedBillings: ['operator'],
                    config: {},
                  },
                  sales: {},
                  accounts: { resolve: async () => null, upsert: async () => [handler()] },
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
              idempotency_key: `account-request-${state}`,
              accounts: [{ brand: row.brand, operator: row.operator, billing: 'operator' }],
            },
          },
        };
        const expected = expectedRow(row, ownsRequests && version === toReleasePrecisionWire(ADCP_VERSION));
        const validate = getSchemaValidatorByRef('account/sync-accounts-response.json', version);
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = await server.dispatchTestRequest(structuredClone(request));
          assert.equal(response.isError, undefined, JSON.stringify(response));
          assert.deepEqual(response.structuredContent.accounts, [expected]);
          assert.equal(validate(response.structuredContent), true, JSON.stringify(validate.errors));
          assert.ok(!JSON.stringify(response).includes('must-not-echo'));
          if (!ownsRequests || version !== toReleasePrecisionWire(ADCP_VERSION)) {
            assert.ok(!JSON.stringify(response).includes('request_id'));
            assert.ok(!JSON.stringify(response).includes('resolution'));
          }
          if (attempt === 1) assert.equal(response.structuredContent.replayed, true);
          if (state === 'pending')
            assert.equal(Object.hasOwn(response.structuredContent.accounts[0], 'account_id'), false);
        }
        assert.equal(writes, 1);
      });
    }
  }
}
