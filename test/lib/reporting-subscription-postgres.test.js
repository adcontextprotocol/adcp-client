/**
 * Reporting subscriptions on PostgreSQL: the principal row (versions, history, readback)
 * and the engine state survive a process restart on PostgresStateStore.
 *
 * Requires a running PostgreSQL instance. Set DATABASE_URL to run:
 *   DATABASE_URL=postgres://localhost/test node --test test/lib/reporting-subscription-postgres.test.js
 *
 * Skipped entirely when DATABASE_URL is not set.
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
const DATABASE_URL = process.env.DATABASE_URL;
const PRINCIPALS = `adcp_principals_subscriptions_${process.pid}`;
const ENGINE = `adcp_subscription_engine_${process.pid}`;

describe('reporting subscriptions on PostgreSQL', { skip: !DATABASE_URL && 'DATABASE_URL not set' }, () => {
  let pool;
  let lib;
  let server;
  let service;

  before(async () => {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: DATABASE_URL });
    lib = require('../../dist/lib/index.js');
    server = require('../../dist/lib/server/index.js');
    service = require('../../dist/lib/reporting/service/index.js');
    await pool.query(lib.ADCP_STATE_MIGRATION);
    await pool.query('DELETE FROM adcp_state WHERE collection = ANY($1)', [[PRINCIPALS, ENGINE]]);
  });

  after(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM adcp_state WHERE collection = ANY($1)', [[PRINCIPALS, ENGINE]]);
    await pool.end();
  });

  function boot(clock) {
    const backing = new lib.PostgresStateStore(pool);
    const store = server.createPrincipalStateStore({ store: backing, collection: PRINCIPALS, durability: 'durable' });
    const notifications = server.createPersistentNotificationRuntime({
      store: server.principalNotificationSubscriptionStore(store),
      proofAdapter: { prove: async () => ({ proved: true }) },
      validateDestination: async () => ({ allowed: true }),
      authorizeDelivery: async () => ({ authorized: true }),
      checkpointDeliveryAttempt: async () => {},
      createEmitter: () => ({
        forTenantScope() {
          return this;
        },
        async emit(params) {
          return {
            delivery_id: params.delivery_id,
            idempotency_key: params.delivery_id,
            attempts: 1,
            delivered: true,
            terminal: true,
            errors: [],
          };
        },
        async emitRecovered(params) {
          return this.emit(params);
        },
      }),
    });
    const lifecycle = server.createPrincipalLifecycle({
      store,
      notifications,
      agentUrl: 'https://seller.example/mcp',
      resolvePrincipal: ctx => ctx.callerMutationScope,
      now: () => clock.now,
      reportingSubscriptions: { listDeliveryConfigIds: () => [] },
    });
    const engineStore = service.createReportingSubscriptionEngineStateStoreV1({
      store: backing,
      collection: ENGINE,
      durability: 'durable',
    });
    const engine = service.createReportingSubscriptionEngineV1({
      principal: lifecycle,
      store: engineStore,
      offerings: [
        {
          offering_id: 'off_a_pkg',
          feed_purpose: 'analytics',
          report_definition_id: 'rd_off_a_pkg',
          report_definition_uri: 'https://seller.example/report-definitions/off_a_pkg.json',
          report_definition_sha256: 'b'.repeat(64),
          reporting_profile: {
            id: 'adcp.delivery.v1',
            version: '1.0.0',
            schema_uri: 'https://seller.example/schemas/delivery.json',
            schema_sha256: 'a'.repeat(64),
            schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
            schema_ref_policy: 'local_fragment_only',
            grain: 'daily',
            primary_keys: ['account_id', 'package_id'],
          },
          schedule: { period_duration: 'P1D', alignment: 'utc', delivery_sla: 'PT6H' },
          supported_finality: ['official'],
          reconciliation_mode: 'delivery_only',
          standard_dimensions: ['package'],
        },
      ],
      statusRetentionDays: 30,
      now: () => clock.now,
      hooks: {
        listAuthorizedAccounts: () => ({
          accounts: clock.revoked ? [] : [{ account_id: 'acct_1', authorized_at: '2026-10-01T00:00:00.000Z' }],
        }),
        listAccountBuys: () => [
          {
            media_buy_id: 'mb_1',
            confirmed_at: '2026-11-02T15:00:00Z',
            start_time: '2026-11-03T00:00:00Z',
            end_time: '2026-11-08T00:00:00Z',
            packages: [{ package_id: 'pkg_1', reporting_delivery_offering_ids: ['off_a_pkg'] }],
          },
        ],
        resolveRevocationInstant: (_principal, _account, input) => input.observedAt,
        isPeriodDelivered: () => false,
      },
    });
    return { lifecycle, engine, engineStore };
  }

  test('versions, lost authority and owed periods survive a restart', async () => {
    const scope = { tenantId: 't', principalId: `p-${process.pid}` };
    const ctx = {
      callerMutationScope: { tenant_id: 't', principal_id: scope.principalId, principal_kind: 'buyer_agent' },
    };
    const clock = { now: new Date('2026-11-01T12:00:00.000Z'), revoked: false };
    const first = boot(clock);
    const subscription = {
      subscription_id: 'analytics-daily',
      subscription_version: 1,
      active: true,
      scope: { all_authorized_accounts: true },
      selector: {
        feed_purpose: 'analytics',
        period_duration: 'P1D',
        required_finality: 'official',
        dimensions: ['package'],
      },
      reconciliation_mode: 'delivery_only',
    };
    const applied = await first.lifecycle.protocol.syncPrincipal(
      { idempotency_key: 'pg-subscription-0001', configuration: { reporting_subscriptions: [subscription] } },
      ctx
    );
    assert.equal(applied.result.kind, 'applied', JSON.stringify(applied));
    clock.now = new Date('2026-11-02T00:00:00.000Z');
    await first.engine.reconcile(scope);
    clock.now = new Date('2026-11-05T05:00:00.000Z');
    clock.revoked = true;
    await first.engine.reconcile(scope);

    const second = boot(clock);
    const read = await second.lifecycle.protocol.getPrincipal({}, ctx);
    const state = read.result.configuration.reporting_subscriptions[0];
    assert.equal(state.accepted_at, '2026-11-01T12:00:00.000Z');
    assert.equal(state.accounts_unauthorized[0].unauthorized_at, '2026-11-05T05:00:00.000Z');
    const owed = await second.engine.owedPeriods(scope, 'acct_1', { now: '2026-11-10T00:00:00.000Z' });
    assert.deepEqual(
      owed.map(row => row.period_start),
      ['2026-11-03T00:00:00.000Z', '2026-11-04T00:00:00.000Z']
    );
    assert.equal(await second.engine.acceptsReceipt(scope, 'acct_1', { readAt: '2026-11-05T01:00:00.000Z' }), true);
    // One document per principal and per account, listed per tenant.
    assert.deepEqual((await second.engineStore.listKeys(scope)).sort(), ['account:acct_1', 'principal']);
    assert.ok((await second.engineStore.listPrincipals('t')).some(item => item.principalId === scope.principalId));
    assert.deepEqual(await second.engineStore.listPrincipals(`other-${process.pid}`), []);
  });
});
