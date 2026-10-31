/**
 * Revocation means no access (adcp#8607): winding down with a reduced grant instead of revoking.
 * `windDownGrant` and `REPORTING_WIND_DOWN_TASKS` (`@adcp/sdk/server`), and the shared vectors in
 * test/fixtures/reporting-subscriptions/grant-cases.json: the coverage grant rule, and grant
 * transitions run through the coverage engine.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, test } = require('node:test');

process.env.NODE_ENV = 'test';

const server = require('@adcp/sdk/server');
const {
  createInMemoryReportingSubscriptionEngineStoreV1,
  createReportingSubscriptionEngineV1,
  reportingSubscriptionCoverageGrantedV1,
} = require('@adcp/sdk/reporting/advanced');
const { createTestPrincipalLifecycle } = require('../helpers/principal-runtime.js');

const vectors = require(path.join(__dirname, '..', 'fixtures', 'reporting-subscriptions', 'grant-cases.json'));

const ACCOUNT = 'account-a';
const OFFERING = 'daily_pkg';
const PRINCIPAL = { tenantId: 'tenant-1', principalId: 'principal-a' };

describe('windDownGrant', () => {
  test('is the reconciliation-only grant, writable, as the vectors define it', () => {
    const { windDownGrant, REPORTING_WIND_DOWN_TASKS } = server;
    assert.deepEqual([...REPORTING_WIND_DOWN_TASKS], vectors.wind_down_grant.allowed_tasks);
    assert.ok(Object.isFrozen(REPORTING_WIND_DOWN_TASKS));
    assert.deepEqual(windDownGrant(), vectors.wind_down_grant);
    assert.equal(reportingSubscriptionCoverageGrantedV1(windDownGrant()), true, 'a wind-down grant keeps coverage');
  });

  test('keeps the authorization chain: authorized_at carries over, the old task scoping does not', () => {
    const { windDownGrant } = server;
    const current = {
      allowed_tasks: ['get_media_buys', 'create_media_buy', 'get_reporting_status'],
      field_scopes: { create_media_buy: ['packages'] },
      scope_name: 'custom:buyer',
      authorized_at: '2026-08-01T00:00:00Z',
      read_only: false,
    };
    assert.deepEqual(windDownGrant(current), { ...vectors.wind_down_grant, authorized_at: '2026-08-01T00:00:00Z' });
    assert.deepEqual(current.allowed_tasks, ['get_media_buys', 'create_media_buy', 'get_reporting_status']);
    const first = windDownGrant();
    first.allowed_tasks.push('create_media_buy');
    assert.deepEqual(windDownGrant().allowed_tasks, vectors.wind_down_grant.allowed_tasks, 'each call is a fresh copy');
  });
});

describe('grant-cases.json: the coverage grant rule', () => {
  for (const testCase of vectors.grant_cases) {
    test(testCase.name, () => {
      const grant = testCase.authorization === null ? {} : testCase.authorization;
      assert.equal(reportingSubscriptionCoverageGrantedV1(grant), testCase.covered);
    });
  }
});

function deliveryOffering() {
  return {
    offering_id: OFFERING,
    feed_purpose: 'analytics',
    report_definition_id: 'daily-delivery',
    report_definition_uri: 'https://seller.example/reports/daily-delivery.json',
    report_definition_sha256: 'a'.repeat(64),
    reporting_profile: {
      id: 'delivery-v1',
      version: '1',
      schema_uri: 'https://seller.example/reports/delivery-v1.json',
      schema_sha256: 'b'.repeat(64),
      schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
      schema_ref_policy: 'bundled_only',
      grain: ['media_buy_id'],
      primary_keys: ['media_buy_id'],
    },
    schedule: { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'PT0S' },
    supported_finality: ['snapshot'],
    reconciliation_mode: 'delivery_only',
    standard_dimensions: [],
  };
}

async function runTransition(testCase) {
  const clock = { now: new Date('2026-09-01T12:00:00Z') };
  const { lifecycle } = createTestPrincipalLifecycle({ clock, reportingSubscriptions: {} });
  const applied = await lifecycle.protocol.syncPrincipal(
    {
      idempotency_key: 'grant-vector-subscription-0001',
      configuration: {
        reporting_subscriptions: [
          {
            subscription_id: 'analytics-daily',
            subscription_version: 1,
            active: true,
            scope: { all_authorized_accounts: true },
            selector: { feed_purpose: 'analytics', period_duration: 'P1D', required_finality: 'snapshot' },
            reconciliation_mode: 'delivery_only',
          },
        ],
      },
    },
    {
      callerMutationScope: {
        tenant_id: PRINCIPAL.tenantId,
        principal_id: PRINCIPAL.principalId,
        principal_kind: 'buyer_agent',
      },
    }
  );
  assert.equal(applied.result.kind, 'applied', JSON.stringify(applied));
  let step;
  const engine = createReportingSubscriptionEngineV1({
    principal: lifecycle,
    offerings: [deliveryOffering()],
    store: createInMemoryReportingSubscriptionEngineStoreV1(),
    statusRetentionDays: 400,
    now: () => clock.now,
    hooks: {
      listAuthorizedAccounts: () => ({
        accounts:
          step.allowed_tasks === 'revoked'
            ? []
            : [
                {
                  account_id: ACCOUNT,
                  authorized_at: '2026-08-01T00:00:00Z',
                  ...(step.granted_at ? { granted_at: step.granted_at } : {}),
                  ...(step.allowed_tasks === null ? {} : { allowed_tasks: step.allowed_tasks }),
                },
              ],
      }),
      listAccountBuys: () => [
        {
          media_buy_id: 'mb-1',
          confirmed_at: '2026-09-01T06:00:00Z',
          start_time: '2026-09-02T00:00:00Z',
          end_time: '2026-09-11T00:00:00Z',
          packages: [{ package_id: 'pkg-1', reporting_delivery_offering_ids: [OFFERING] }],
        },
      ],
      resolveRevocationInstant: (_principal, _account, input) => input.observedAt,
      isPeriodDelivered: () => false,
    },
  });
  for (step of testCase.steps) {
    clock.now = new Date(step.at);
    await engine.reconcile(PRINCIPAL);
  }
  clock.now = new Date(testCase.evaluate_at);
  await engine.reconcile(PRINCIPAL);
  const [state] = (await lifecycle.listReportingSubscriptions(PRINCIPAL)).states;
  return {
    authorized: await engine.isAuthorized(PRINCIPAL, ACCOUNT),
    covered: (await engine.subscriptionCoverage(PRINCIPAL, ACCOUNT)).length > 0,
    unauthorized_at: (state.accounts_unauthorized ?? [])
      .filter(entry => entry.account_id === ACCOUNT)
      .map(entry => Date.parse(entry.unauthorized_at)),
    owed: (await engine.owedPeriods(PRINCIPAL, ACCOUNT)).map(period => Date.parse(period.period_start)),
  };
}

describe('grant-cases.json: grant transitions through the coverage engine', () => {
  for (const testCase of vectors.transition_cases) {
    test(testCase.name, async () => {
      const actual = await runTransition(testCase);
      assert.deepEqual(actual, {
        authorized: testCase.expected.authorized,
        covered: testCase.expected.covered,
        unauthorized_at: testCase.expected.unauthorized_at.map(Date.parse),
        owed: testCase.expected.owed.map(Date.parse),
      });
    });
  }
});
