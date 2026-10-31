/**
 * Subscription generations on PostgreSQL (experimental `media_buy.reporting_subscriptions`, AdCP 3.3):
 * the additive `subscription_key` migration on a fresh and on a published schema, the widened
 * generation key, owed-set progress, and caller isolation between principals that share a
 * subscription_id on one account.
 */
const assert = require('node:assert/strict');
const { after, before, describe, test } = require('node:test');

const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;
const DAY = 86_400_000;
const ACCOUNT = 'subscription-pg-account';
const PRINCIPAL_A = { tenantId: 'tenant-1', principalId: 'principal-a' };
const PRINCIPAL_B = { tenantId: 'tenant-1', principalId: 'principal-b' };

/** The published configuration layout, before subscription generations. */
const PUBLISHED_CONFIGURATIONS = `CREATE TABLE adcp_reporting_configurations (
  configuration_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, delivery_config_id TEXT NOT NULL,
  delivery_config_version INTEGER NOT NULL, semantic_fingerprint TEXT NOT NULL,
  data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (account_id, delivery_config_id, delivery_config_version))`;

async function generationConstraints(pool) {
  const unique = await pool.query(
    `SELECT (
       SELECT array_agg(attribute.attname::text ORDER BY attribute.attname::text)
         FROM unnest(constraint_row.conkey) AS key(attnum)
         JOIN pg_attribute attribute
           ON attribute.attrelid = constraint_row.conrelid AND attribute.attnum = key.attnum
     ) AS columns
       FROM pg_constraint constraint_row
      WHERE constraint_row.conrelid = 'adcp_reporting_configurations'::regclass AND constraint_row.contype = 'u'`
  );
  const index = await pool.query(
    `SELECT indexdef FROM pg_indexes
      WHERE tablename = 'adcp_reporting_configurations' AND indexname = 'adcp_reporting_configurations_generation'
        AND schemaname = current_schema()`
  );
  const column = await pool.query(
    `SELECT column_default, is_nullable FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'adcp_reporting_configurations'
        AND column_name = 'subscription_key'`
  );
  return {
    uniqueConstraints: unique.rows.map(row => [...row.columns].join(',')),
    generationIndex: index.rows[0]?.indexdef ?? null,
    subscriptionKey: column.rows[0] ?? null,
  };
}

describe('PostgreSQL subscription generations', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  const fresh = `adcp_reporting_subscription_fresh_${process.pid}`;
  const published = `adcp_reporting_subscription_published_${process.pid}`;
  let bootstrap;
  let freshPool;
  let publishedPool;
  let ledger;
  let sourceApi;

  before(async () => {
    const { Pool } = require('pg');
    ledger = require('./helpers/ledger.js');
    sourceApi = require('@adcp/sdk/reporting/source');
    bootstrap = new Pool({ connectionString: DATABASE_URL });
    await bootstrap.query(`CREATE SCHEMA "${fresh}"`);
    await bootstrap.query(`CREATE SCHEMA "${published}"`);
    freshPool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${fresh}"` });
    publishedPool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${published}"` });
  });

  after(async () => {
    await freshPool?.end();
    await publishedPool?.end();
    if (bootstrap) {
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${fresh}" CASCADE`);
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${published}" CASCADE`);
      await bootstrap.end();
    }
  });

  test('a fresh schema keys generations by subscription_key and reruns idempotently', async () => {
    await freshPool.query(ledger.REPORTING_LEDGER_MIGRATION);
    await freshPool.query(ledger.REPORTING_LEDGER_MIGRATION);
    const state = await generationConstraints(freshPool);
    assert.deepEqual(state.uniqueConstraints, []);
    assert.match(
      state.generationIndex,
      /UNIQUE INDEX adcp_reporting_configurations_generation .*\(account_id, delivery_config_id, delivery_config_version, subscription_key\)/
    );
    assert.equal(state.subscriptionKey.is_nullable, 'NO');
    assert.match(state.subscriptionKey.column_default, /''::text/);
  });

  test('an existing schema keeps its rows and gains the widened key', async () => {
    await publishedPool.query(PUBLISHED_CONFIGURATIONS);
    const legacy = {
      configurationId: 'legacy-generation',
      account: { account_id: ACCOUNT },
      delivery_config_id: 'legacy',
      delivery_config_version: 1,
      semanticFingerprint: 'sha256:legacy',
    };
    await publishedPool.query(
      `INSERT INTO adcp_reporting_configurations VALUES ($1, $2, $3, $4, $5, $6::jsonb, clock_timestamp())`,
      ['legacy-generation', ACCOUNT, 'legacy', 1, legacy.semanticFingerprint, JSON.stringify(legacy)]
    );
    assert.deepEqual((await generationConstraints(publishedPool)).uniqueConstraints, [
      'account_id,delivery_config_id,delivery_config_version',
    ]);
    await publishedPool.query(ledger.REPORTING_LEDGER_MIGRATION);
    await publishedPool.query(ledger.REPORTING_LEDGER_MIGRATION);
    const state = await generationConstraints(publishedPool);
    assert.deepEqual(state.uniqueConstraints, [], 'the published three-column constraint is dropped by its columns');
    assert.ok(state.generationIndex);
    const rows = await publishedPool.query(
      'SELECT configuration_id, subscription_key, data FROM adcp_reporting_configurations'
    );
    assert.deepEqual(
      rows.rows.map(row => [row.configuration_id, row.subscription_key]),
      [['legacy-generation', '']]
    );
    assert.deepEqual(rows.rows[0].data, legacy);
    // An account generation is still unique per (account, id, version).
    await assert.rejects(
      publishedPool.query(
        `INSERT INTO adcp_reporting_configurations
           (configuration_id, account_id, delivery_config_id, delivery_config_version, semantic_fingerprint, data, created_at)
         VALUES ('legacy-duplicate', $1, 'legacy', 1, 'sha256:other', '{}'::jsonb, clock_timestamp())`,
        [ACCOUNT]
      ),
      /duplicate key value/
    );
    const store = new ledger.PostgresReportingLedgerStore(publishedPool, { acknowledgeIsolatedDatabase: true });
    assert.deepEqual(await store.listConfigurations(ACCOUNT), [legacy]);
  });

  test('two principals own the same subscription_id beside an account generation', async () => {
    const store = new ledger.PostgresReportingLedgerStore(freshPool, { acknowledgeIsolatedDatabase: true });
    const offering = sourceApi.redactedReportingSourceOfferingV1;
    const request = sourceApi.redactedReportingSourceRequestV1();
    const producer = ledger.createReportingProducer({
      store,
      source: sourceApi.createInlineReportingSourceExecutor(() => [], offering),
      offerings: [offering],
      contact: { name: 'Reporting operations' },
    });
    const origin = Math.floor(Date.now() / DAY) * DAY - 10 * DAY;
    const day = n => new Date(origin + n * DAY).toISOString();
    const base = request.coverage.constituents[0];
    const constituent = mediaBuyId => ({
      ...structuredClone(base),
      constituentId: `constituent-${mediaBuyId}`,
      mediaBuyId,
      productBinding: { ...structuredClone(base.productBinding), mediaBuyId, bindingId: `binding-${mediaBuyId}` },
    });
    const generation = principal => ({
      account: { account_id: ACCOUNT },
      sourceScope: request.sourceScope,
      delivery_config_id: request.delivery_config_id,
      delivery_config_version: 1,
      offeringId: offering.offeringId,
      report_definition_id: request.report_definition_id,
      feedPurpose: 'analytics',
      requiredFinality: 'snapshot',
      requestedMetrics: request.requestedMetrics,
      requestedDimensions: request.requestedDimensions,
      sourceTimezone: 'UTC',
      schedule: {
        anchor: '1970-01-01T00:00:00.000Z',
        periodMilliseconds: DAY,
        deliverySlaMilliseconds: 3_600_000,
        recoveryWindowMilliseconds: DAY,
        periodDuration: 'P1D',
        alignment: 'utc',
        deliverySlaDuration: 'PT1H',
      },
      sourceSettings: request.sourceSettings,
      contract: request.contract,
      subscription: {
        ...principal,
        subscriptionId: request.delivery_config_id,
        offeringId: offering.offeringId,
        ownership: 'owed_set',
      },
    });
    const plan = (principal, starts, mediaBuyId, through) => ({
      account_id: ACCOUNT,
      principal,
      subscriptionId: request.delivery_config_id,
      configurations: [generation(principal)],
      obligations: starts.map(start => ({
        delivery_config_version: 1,
        offeringId: offering.offeringId,
        period: { start: day(start), end: day(start + 1) },
        mediaBuyIds: [mediaBuyId],
        constituents: [constituent(mediaBuyId)],
      })),
      owedThrough: day(through),
      now: day(through),
    });

    // An account generation with the very same (account, id, version).
    const account = await producer.installConfiguration({
      account: { account_id: ACCOUNT },
      sourceScope: request.sourceScope,
      delivery_config_id: request.delivery_config_id,
      delivery_config_version: 1,
      offeringId: offering.offeringId,
      report_definition_id: request.report_definition_id,
      feedPurpose: 'analytics',
      requiredFinality: 'snapshot',
      requestedMetrics: request.requestedMetrics,
      requestedDimensions: request.requestedDimensions,
      constituents: request.coverage.constituents,
      mediaBuyIds: request.coverage.mediaBuyIds,
      sourceTimezone: 'UTC',
      schedule: {
        anchor: new Date(origin).toISOString(),
        periodMilliseconds: DAY,
        deliverySlaMilliseconds: 0,
        recoveryWindowMilliseconds: DAY,
      },
      sourceSettings: request.sourceSettings,
      contract: request.contract,
    });
    const a = await producer.planSubscriptionObligations(plan(PRINCIPAL_A, [1, 4], 'mb-a', 6));
    const b = await producer.planSubscriptionObligations(plan(PRINCIPAL_B, [2], 'mb-b', 6));
    // Replays are idempotent against the widened key.
    assert.deepEqual((await producer.planSubscriptionObligations(plan(PRINCIPAL_A, [1, 4], 'mb-a', 6))).created, []);
    assert.equal(a.created.length, 2);
    assert.equal(b.created.length, 1);
    const keys = await freshPool.query(
      `SELECT configuration_id, subscription_key FROM adcp_reporting_configurations
        WHERE account_id = $1 ORDER BY subscription_key`,
      [ACCOUNT]
    );
    assert.equal(keys.rows.length, 3);
    assert.deepEqual(Object.fromEntries(keys.rows.map(row => [row.configuration_id, row.subscription_key])), {
      [account.configurationId]: '',
      [a.configurations[0].configurationId]: ledger.reportingLedgerSubscriptionKeyV1(a.configurations[0]),
      [b.configurations[0].configurationId]: ledger.reportingLedgerSubscriptionKeyV1(b.configurations[0]),
    });
    // A changed generation is immutable.
    const changed = plan(PRINCIPAL_A, [1], 'mb-a', 6);
    changed.configurations[0].requestedMetrics = ['impressions'];
    await assert.rejects(
      producer.planSubscriptionObligations(changed),
      error => error.code === 'REPORTING_CONFIGURATION_IMMUTABLE'
    );

    // Owed-set progress is mutable, monotonic and outside the fingerprint.
    const [stored] = (await store.listConfigurations(ACCOUNT)).filter(
      value => value.configurationId === a.configurations[0].configurationId
    );
    assert.deepEqual(stored.owedSet, { through: day(6), from: day(1), until: day(5), mediaBuyIds: ['mb-a'] });
    assert.equal(stored.semanticFingerprint, a.configurations[0].semanticFingerprint);
    const regressed = await store.recordOwedSetProgress({
      configurationId: stored.configurationId,
      account_id: ACCOUNT,
      through: day(2),
    });
    assert.equal(regressed.owedSet.through, day(6));
    await assert.rejects(
      store.recordOwedSetProgress({ configurationId: account.configurationId, account_id: ACCOUNT, through: day(6) }),
      error => /Unknown subscription reporting configuration/.test(error.cause?.message ?? error.message)
    );
    const found = await store.findObligationByOrdinal({
      account_id: ACCOUNT,
      configurationId: stored.configurationId,
      periodOrdinal: Math.floor(Date.parse(day(4)) / 1_000),
    });
    assert.equal(found.period.start, day(4));

    // Each principal sees account generations plus only its own subscription generation.
    const snapshot = principal =>
      store.createSnapshot({
        account_id: ACCOUNT,
        view: 'periods',
        ...(principal ? { subscription_principal: principal } : {}),
        period: { start: day(0), end: day(6) },
      });
    const forA = await snapshot(PRINCIPAL_A);
    const forB = await snapshot(PRINCIPAL_B);
    const anonymous = await snapshot(undefined);
    const ids = value => value.configurations.map(item => item.configurationId).sort();
    assert.deepEqual(ids(forA), [account.configurationId, a.configurations[0].configurationId].sort());
    assert.deepEqual(ids(forB), [account.configurationId, b.configurations[0].configurationId].sort());
    assert.deepEqual(ids(anonymous), [account.configurationId]);
    const subscriptionPeriods = value =>
      value.obligations
        .filter(item => item.subscription)
        .map(item => [item.subscription.principalId, item.period.start]);
    assert.deepEqual(subscriptionPeriods(forA), [
      ['principal-a', day(1)],
      ['principal-a', day(4)],
    ]);
    assert.deepEqual(subscriptionPeriods(forB), [['principal-b', day(2)]]);
    assert.deepEqual(subscriptionPeriods(anonymous), []);

    // The status handler reads through the same filter.
    const handler = ledger.createReportingStatusHandler(store, {
      resolveSubscriptionPrincipal: context => context.principal,
    });
    const read = principal =>
      handler(
        {
          account: { account_id: ACCOUNT },
          view: 'periods',
          period: { start: day(0), end: day(6) },
          pagination: { max_results: 100 },
        },
        { account: { account_id: ACCOUNT }, principal }
      );
    const periodsA = await read(PRINCIPAL_A);
    assert.equal(periodsA.status, 'completed', JSON.stringify(periodsA));
    assert.deepEqual(
      periodsA.periods.filter(value => value.offering_id).map(value => value.media_buy_ids),
      [['mb-a'], ['mb-a']]
    );
    const periodsB = await read(PRINCIPAL_B);
    assert.deepEqual(
      periodsB.periods.filter(value => value.offering_id).map(value => value.media_buy_ids),
      [['mb-b']]
    );
  });
});
