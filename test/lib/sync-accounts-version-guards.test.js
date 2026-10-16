const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { SingleAgentClient, ProtocolClient, ProtocolFeatureUnsupportedError } = require('../../dist/lib/index.js');

const LEGACY_VERSION = '3.1';
const CURRENT_VERSION = '3.2.1';
const LEGACY_ACCOUNT = {
  brand: { domain: 'brand.example' },
  operator: 'agency.example',
  billing: 'operator',
};
const IDENTITY_FIELDS = [
  ['operator_unit', { operator_unit: { id: 'buying-desk' } }],
  ['currency', { currency: 'USD' }],
  ['timezone', { timezone: 'America/New_York' }],
  ['brand.countries', { brand: { domain: 'brand.example', countries: ['US'] } }],
];

function capabilities(version = CURRENT_VERSION, overrides = {}) {
  return {
    version: 'v3',
    majorVersions: [3],
    supportedVersions: [version],
    protocols: ['media_buy'],
    features: {},
    extensions: [],
    _synthetic: false,
    ...overrides,
  };
}

function request(account = LEGACY_ACCOUNT) {
  return { idempotency_key: 'sync-account-version-guard', accounts: [structuredClone(account)] };
}

function makeClient(config = {}, sellerCapabilities = capabilities(), protocol = 'mcp') {
  const client = new SingleAgentClient(
    {
      id: `sync-account-${protocol}`,
      name: 'Sync account seller',
      agent_uri: `https://seller.example/${protocol}`,
      protocol,
    },
    {
      adcpVersion: CURRENT_VERSION,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
      ...config,
    }
  );
  const discovered = [];
  client.ensureEndpointDiscovered = async () => client.agent;
  client.getCapabilities = async options => {
    discovered.push(options);
    return sellerCapabilities;
  };
  return { client, discovered };
}

function captureDispatch(t) {
  const calls = [];
  t.mock.method(ProtocolClient, 'callTool', async (_agent, taskName, params) => {
    calls.push({ taskName, params });
    return { status: 'completed', accounts: [] };
  });
  return calls;
}

function unsupported(field, currentVersion = LEGACY_VERSION) {
  return error => {
    assert.ok(error instanceof ProtocolFeatureUnsupportedError, `got ${error?.constructor?.name}: ${error?.message}`);
    assert.equal(error.code, 'UNSUPPORTED_FEATURE');
    assert.equal(error.details.required_version, '3.2');
    assert.equal(error.details.current_version, currentVersion);
    assert.equal(error.details.tool, 'sync_accounts');
    assert.equal(error.details.field, field);
    assert.equal(error.adcpError.field, field);
    assert.match(error.message, /requires AdCP 3\.2/);
    assert.match(error.message, /No request was sent\./);
    assert.match(error.adcpError.suggestion, /explicit/i);
    assert.match(error.adcpError.suggestion, /project/i);
    return true;
  };
}

describe('sync_accounts provisioning identity version guards', () => {
  for (const versionOption of ['adcpVersion', 'wireAdcpVersion']) {
    for (const [field, extra] of IDENTITY_FIELDS) {
      test(`${versionOption} below 3.2 refuses ${field} before validation or discovery`, async t => {
        const { client, discovered } = makeClient({
          [versionOption]: LEGACY_VERSION,
          validation: { requests: 'strict', responses: 'off' },
        });
        const calls = captureDispatch(t);
        const validations = [];
        client.executor.validateRequest = (...args) => validations.push(args);

        await assert.rejects(
          client.executeTask('sync_accounts', request({ ...LEGACY_ACCOUNT, ...extra })),
          unsupported(`accounts[0].${field}`)
        );
        assert.equal(validations.length, 0);
        assert.equal(discovered.length, 0);
        assert.equal(calls.length, 0);
      });
    }
  }

  test('a modern wire override cannot bypass a legacy public AdCP pin', async t => {
    const { client } = makeClient({ adcpVersion: LEGACY_VERSION, wireAdcpVersion: CURRENT_VERSION });
    const calls = captureDispatch(t);
    await assert.rejects(
      client.executeTask('sync_accounts', request({ ...LEGACY_ACCOUNT, currency: 'USD' })),
      unsupported('accounts[0].currency')
    );
    assert.equal(calls.length, 0);
  });

  for (const requests of ['off', 'warn', 'strict']) {
    for (const target of ['configured client', 'discovered seller']) {
      test(`${target} refusal applies with request validation ${requests}`, async t => {
        const { client } = makeClient(
          {
            ...(target === 'configured client' && { adcpVersion: LEGACY_VERSION }),
            validation: { requests, responses: 'off' },
          },
          capabilities(LEGACY_VERSION)
        );
        const calls = captureDispatch(t);
        await assert.rejects(
          client.executeTask('sync_accounts', request({ ...LEGACY_ACCOUNT, currency: 'USD' })),
          unsupported('accounts[0].currency')
        );
        assert.equal(calls.length, 0);
      });
    }
  }

  for (const target of ['configured client', 'discovered seller']) {
    test(`${target} refusal applies with skipRequestValidation`, async t => {
      const { client } = makeClient(
        target === 'configured client' ? { adcpVersion: LEGACY_VERSION } : {},
        capabilities(LEGACY_VERSION)
      );
      const calls = captureDispatch(t);
      await assert.rejects(
        client.executeTask('sync_accounts', request({ ...LEGACY_ACCOUNT, currency: 'USD' }), undefined, {
          skipRequestValidation: true,
        }),
        unsupported('accounts[0].currency')
      );
      assert.equal(calls.length, 0);
    });
  }

  for (const protocol of ['mcp', 'a2a']) {
    for (const [field, extra] of IDENTITY_FIELDS) {
      test(`${protocol} cold discovery refuses a pre-3.2 seller for ${field}`, async t => {
        const { client, discovered } = makeClient({}, capabilities(LEGACY_VERSION), protocol);
        assert.equal(client.cachedCapabilities, undefined);
        const calls = captureDispatch(t);
        await assert.rejects(
          client.executeTask('sync_accounts', request({ ...LEGACY_ACCOUNT, ...extra })),
          unsupported(`accounts[0].${field}`)
        );
        assert.ok(discovered.length > 0, 'the first request must discover the seller version');
        assert.equal(calls.length, 0);
      });
    }
  }

  test('the error identifies the provisioning entry after a settings update', async t => {
    const { client } = makeClient({}, capabilities(LEGACY_VERSION));
    const calls = captureDispatch(t);
    const params = request();
    params.accounts = [
      { account: { account_id: 'existing-account' }, name: 'Updated name' },
      { ...LEGACY_ACCOUNT, timezone: 'UTC' },
    ];
    await assert.rejects(client.executeTask('sync_accounts', params), unsupported('accounts[1].timezone'));
    assert.equal(calls.length, 0);
  });

  for (const extra of [
    { account: null },
    { account: { account_id: 'existing-account' } },
    { account_id: 'extension' },
  ]) {
    test(`adding ${JSON.stringify(extra)} cannot bypass a provisioning identity guard`, async t => {
      const { client } = makeClient({}, capabilities(LEGACY_VERSION));
      const calls = captureDispatch(t);
      await assert.rejects(
        client.executeTask('sync_accounts', request({ ...LEGACY_ACCOUNT, currency: 'USD', ...extra }), undefined, {
          skipRequestValidation: true,
        }),
        unsupported('accounts[0].currency')
      );
      assert.equal(calls.length, 0);
    });
  }

  test('request-scoped legacy capabilities override a stale modern cache', async t => {
    const { client } = makeClient({}, capabilities(LEGACY_VERSION));
    client.cachedCapabilities = capabilities();
    const calls = captureDispatch(t);
    await assert.rejects(
      client.executeTask('sync_accounts', request({ ...LEGACY_ACCOUNT, currency: 'USD' })),
      unsupported('accounts[0].currency')
    );
    assert.equal(calls.length, 0);
  });

  for (const evidence of [{ servedVersion: LEGACY_VERSION }, { _raw: { adcp_version: LEGACY_VERSION } }]) {
    test(`the selected ${Object.keys(evidence)[0]} release overrides advertised 3.2 support`, async t => {
      const { client } = makeClient({}, capabilities(CURRENT_VERSION, evidence));
      const calls = captureDispatch(t);
      await assert.rejects(
        client.executeTask('sync_accounts', request({ ...LEGACY_ACCOUNT, currency: 'USD' })),
        unsupported('accounts[0].currency')
      );
      assert.equal(calls.length, 0);
    });
  }

  for (const [label, caps] of [
    ['missing release metadata', capabilities(undefined, { supportedVersions: undefined })],
    ['synthetic discovery', capabilities(undefined, { supportedVersions: undefined, _synthetic: true })],
    ['malformed release metadata', capabilities('not-a-version')],
    ['v2 seller', capabilities('2.5', { version: 'v2', majorVersions: [2] })],
  ]) {
    test(`${label} cannot establish support for provisioning identity`, async t => {
      const { client } = makeClient({}, caps);
      const calls = captureDispatch(t);
      await assert.rejects(
        client.executeTask('sync_accounts', request({ ...LEGACY_ACCOUNT, currency: 'USD' })),
        error => {
          assert.ok(error instanceof ProtocolFeatureUnsupportedError);
          assert.equal(error.details.required_version, '3.2');
          assert.equal(error.details.field, 'accounts[0].currency');
          assert.match(error.message, /No request was sent\./);
          return true;
        }
      );
      assert.equal(calls.length, 0);
    });
  }

  test('3.2 preserves every identity field using request-scoped support over a stale legacy cache', async t => {
    const { client } = makeClient();
    client.cachedCapabilities = capabilities(LEGACY_VERSION);
    const calls = captureDispatch(t);
    const account = {
      ...LEGACY_ACCOUNT,
      ...Object.assign({}, ...IDENTITY_FIELDS.map(([_field, extra]) => extra)),
    };
    const params = request(account);
    const snapshot = structuredClone(params);
    const result = await client.executeTask('sync_accounts', params);
    assert.equal(result.success, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].taskName, 'sync_accounts');
    assert.deepEqual(calls[0].params.accounts, [account]);
    assert.deepEqual(params, snapshot, 'dispatch must not mutate the caller request');
  });

  for (const target of ['configured client', 'discovered seller']) {
    for (const [field, extra] of IDENTITY_FIELDS) {
      test(`${target} refuses ${field} nested in a settings-update account reference`, async t => {
        const { client } = makeClient(
          target === 'configured client' ? { adcpVersion: LEGACY_VERSION } : {},
          capabilities(LEGACY_VERSION)
        );
        const calls = captureDispatch(t);
        const account = {
          account: { brand: LEGACY_ACCOUNT.brand, operator: LEGACY_ACCOUNT.operator, ...extra },
          notification_configs: [],
        };
        await assert.rejects(
          client.executeTask('sync_accounts', request(account)),
          unsupported(`accounts[0].account.${field}`)
        );
        assert.equal(calls.length, 0);
      });
    }
  }

  test('3.2 preserves every identity field nested in a settings-update account reference', async t => {
    const { client } = makeClient();
    const calls = captureDispatch(t);
    const account = {
      account: {
        brand: LEGACY_ACCOUNT.brand,
        operator: LEGACY_ACCOUNT.operator,
        ...Object.assign({}, ...IDENTITY_FIELDS.map(([_field, extra]) => extra)),
      },
      notification_configs: [],
    };
    const result = await client.executeTask('sync_accounts', request(account));
    assert.equal(result.success, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params.accounts, [account]);
  });

  test('legacy settings updates can address an ordinary brand and operator account reference', async t => {
    const { client } = makeClient({ adcpVersion: LEGACY_VERSION }, capabilities(LEGACY_VERSION));
    const calls = captureDispatch(t);
    const account = {
      account: { brand: LEGACY_ACCOUNT.brand, operator: LEGACY_ACCOUNT.operator },
      notification_configs: [],
    };
    const result = await client.executeTask('sync_accounts', request(account));
    assert.equal(result.success, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params.accounts, [account]);
  });

  test('callers can explicitly project a provisioning request to the legacy identity', async t => {
    const { client } = makeClient({ adcpVersion: LEGACY_VERSION }, capabilities(LEGACY_VERSION));
    const calls = captureDispatch(t);
    const result = await client.executeTask('sync_accounts', request());
    assert.equal(result.success, true);
    assert.deepEqual(
      calls.map(call => call.params.accounts),
      [[LEGACY_ACCOUNT]]
    );
  });

  for (const [field] of IDENTITY_FIELDS) {
    test(`an undefined ${field} remains equivalent to an omitted legacy field`, async t => {
      const { client } = makeClient({ adcpVersion: LEGACY_VERSION }, capabilities(LEGACY_VERSION));
      const calls = captureDispatch(t);
      const extra =
        field === 'brand.countries'
          ? { brand: { ...LEGACY_ACCOUNT.brand, countries: undefined } }
          : { [field]: undefined };
      const result = await client.executeTask('sync_accounts', request({ ...LEGACY_ACCOUNT, ...extra }));
      assert.equal(result.success, true);
      assert.equal(calls.length, 1);
      assert.deepEqual(JSON.parse(JSON.stringify(calls[0].params.accounts)), [LEGACY_ACCOUNT]);
    });
  }

  test('existing account references in settings updates are not treated as provisioning', async t => {
    const { client } = makeClient({ adcpVersion: LEGACY_VERSION }, capabilities(LEGACY_VERSION));
    const calls = captureDispatch(t);
    const account = { account: { account_id: 'existing-account' }, notification_configs: [] };
    const result = await client.executeTask('sync_accounts', request(account));
    assert.equal(result.success, true);
    assert.deepEqual(
      calls.map(call => call.params.accounts),
      [[account]]
    );
  });
});
