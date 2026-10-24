/**
 * Runs the shared cross-version translation vectors (adcontextprotocol/adcp
 * `static/compliance/source/test-vectors/version-translation/`, proposed
 * DR-0032 / DR-0033) against this SDK. Every AdCP SDK runs the same cases.
 *
 * The vectors are vendored under test/fixtures until the spec publishes them
 * in a compliance bundle; then this file reads them from the synced cache.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const vectors = require(path.join(__dirname, '..', 'fixtures', 'version-translation', 'vectors.json'));
const { SingleAgentClient, ProtocolClient, ProtocolFeatureUnsupportedError } = require('../../dist/lib/index.js');
const {
  convertRequest,
  convertResponse,
  downgradeResponse,
  negotiateAdcpRelease,
} = require('../../dist/lib/adapters/version/index.js');

/** Vector releases are release-precision; the client pins full semver. */
const pin = version => (/^\d+\.\d+$/.test(version) ? `${version}.0` : version.replace(/^(\d+\.\d+)-/, '$1.0-'));

const caps = supportedVersions => ({
  version: 'v3',
  majorVersions: [3],
  supportedVersions,
  protocols: ['media_buy'],
  features: {},
  extensions: [],
  idempotency: { replayTtlSeconds: 86400 },
  _synthetic: false,
});

function casStorage() {
  const rows = new Map();
  return {
    async get(key) {
      const row = rows.get(key);
      return row && structuredClone(row);
    },
    async set(key, value) {
      rows.set(key, structuredClone(value));
    },
    async compareAndSet(key, expectedRevision, value) {
      if (rows.get(key)?.revision !== expectedRevision) return false;
      rows.set(key, structuredClone(value));
      return true;
    },
  };
}

function makeClient(sellerCaps, config = {}) {
  const client = new SingleAgentClient(
    { id: 'vector-seller', name: 'Vector seller', agent_uri: 'https://seller.example/mcp', protocol: 'mcp' },
    { adcpVersion: '3.2.5', validateFeatures: false, validation: { requests: 'off', responses: 'off' }, ...config }
  );
  client.ensureEndpointDiscovered = async () => client.agent;
  client.getCapabilities = async () => sellerCaps();
  return client;
}

describe('version-translation vectors: cases', () => {
  for (const vector of vectors.cases) {
    test(`${vector.side} ${vector.direction} ${vector.id}`, async t => {
      const { expect } = vector;
      if (vector.direction === 'request_down' && expect.reason === 'task_not_defined') {
        const calls = [];
        t.mock.method(ProtocolClient, 'callTool', async (...args) => calls.push(args));
        const client = makeClient(() => caps([vector.to_version]));
        await assert.rejects(client.executeTask(vector.tool, vector.input), ProtocolFeatureUnsupportedError);
        assert.equal(calls.length, 0);
        return;
      }
      if (vector.direction === 'request_down') {
        const translation = convertRequest(vector.tool, structuredClone(vector.input), {
          fromVersion: '3.2.5',
          toVersion: vector.to_version,
          accountIdentity: vector.account_identity ?? 'refuse',
        });
        const identity = translation.identityFields.map(field => field.path);
        const refused = translation.refusedFields.map(field => field.path);
        if (expect.outcome === 'refused') {
          assert.deepEqual(expect.reason === 'account_identity' ? identity : refused, expect.fields);
          return;
        }
        assert.deepEqual(refused, []);
        assert.deepEqual(translation.params, expect.output);
        const reported = translation.drifts
          .filter(drift => drift.type !== 'account_identity_reduced')
          .flatMap(drift => drift.strippedFields ?? [])
          // The 3.0 brand adapter predates JSON paths.
          .map(field => (field === 'brand_kit_override' ? 'brand.brand_kit_override' : field));
        assert.deepEqual(reported.sort(), [...expect.dropped].sort());
        assert.deepEqual(
          translation.drifts.flatMap(drift => drift.movedFields ?? []),
          expect.moved
        );
        if (expect.account_identity_reduced) {
          const reduced = translation.drifts.filter(drift => drift.type === 'account_identity_reduced');
          assert.deepEqual(
            reduced.flatMap(drift => drift.strippedFields),
            expect.account_identity_reduced
          );
        }
        return;
      }
      const translation =
        vector.direction === 'response_up'
          ? convertResponse(vector.tool, structuredClone(vector.input), {
              fromVersion: vector.from_version,
              toVersion: '3.2.5',
            })
          : downgradeResponse(vector.tool, structuredClone(vector.input), {
              fromVersion: '3.2.5',
              toVersion: vector.to_version,
            });
      assert.deepEqual(translation.data, expect.output);
      if (expect.dropped) {
        assert.deepEqual(
          translation.drifts.flatMap(drift => drift.strippedFields ?? []).sort(),
          [...expect.dropped].sort()
        );
      }
      assert.deepEqual(
        translation.drifts.flatMap(drift => drift.movedFields ?? []),
        expect.moved
      );
    });
  }
});

describe('version-translation vectors: negotiation', () => {
  for (const vector of vectors.negotiation) {
    test(`${vector.client_version} against ${vector.seller_supported_versions.join(', ')}`, () => {
      const result = negotiateAdcpRelease(pin(vector.client_version), caps(vector.seller_supported_versions));
      if (vector.expect.outcome === 'no_common_version') {
        assert.equal(result.reason, 'no_common_version');
        return;
      }
      assert.equal(result.downgraded ? result.version : vector.client_version, vector.expect.version);
    });
  }
});

describe('version-translation vectors: account sequences', () => {
  for (const sequence of vectors.account_sequences) {
    test(sequence.id, async t => {
      const calls = [];
      t.mock.method(ProtocolClient, 'callTool', async (_agent, taskName, params) => {
        calls.push({ taskName, params });
        if (taskName === 'sync_accounts') {
          return {
            structuredContent: {
              accounts: params.accounts.map(row => ({
                account_id: 'acct_1',
                brand: row.brand,
                operator: row.operator,
                action: 'created',
                status: 'active',
              })),
            },
          };
        }
        return { structuredContent: { media_buy_id: 'mb_1', media_buy_status: 'active', packages: [] } };
      });
      let sellerVersion = sequence.seller_version;
      const client = makeClient(() => caps(sellerVersion === '3.1' ? ['3.1'] : ['3.1', '3.2']), {
        accountIdentityDowngrade: 'reduce',
        accountStorage: casStorage(),
      });
      for (const [index, step] of sequence.steps.entries()) {
        sellerVersion = step.seller_version ?? sellerVersion;
        const request =
          step.tool === 'sync_accounts'
            ? {
                idempotency_key: `vector-sync-${index}-000000`,
                accounts: step.accounts.map(account => ({ ...account, billing: 'operator' })),
              }
            : {
                idempotency_key: `vector-buy-${index}-0000000`,
                account: step.account,
                brand: { domain: step.account.brand.domain },
                start_time: 'asap',
                end_time: '2027-01-31T23:59:59Z',
                packages: [{ product_id: 'prod_1', pricing_option_id: 'po_1', budget: 100 }],
              };
        const before = calls.length;
        if (step.expect.outcome === 'refused') {
          await assert.rejects(client.executeTask(step.tool, request), error => {
            assert.ok(error instanceof ProtocolFeatureUnsupportedError, error?.message);
            assert.equal(error.details.reason, step.expect.reason);
            return true;
          });
          assert.equal(calls.length, before, `step ${index} must not be sent`);
          continue;
        }
        const result = await client.executeTask(step.tool, request);
        assert.equal(result.success, true, result.error);
        const sent = calls.at(-1).params;
        const keys =
          step.tool === 'sync_accounts' ? sent.accounts.map(({ billing: _, ...key }) => key) : [sent.account];
        assert.deepEqual(keys, step.expect.account_keys);
        if (step.expect.migration_pending) {
          const drift = result.debug_logs.find(entry => entry.type === 'account_identity_migration_pending');
          assert.deepEqual(drift.accounts[0].fields, step.expect.migration_pending.fields);
          assert.equal(
            drift.accounts[0].fields.every(field => field === 'operator_unit'),
            step.expect.migration_pending.in_place
          );
        }
      }
    });
  }
});
