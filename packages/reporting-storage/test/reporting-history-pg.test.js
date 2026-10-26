const assert = require('node:assert/strict');
const { before, after, describe, test } = require('node:test');
const { Pool } = require('pg');
const { PostgresReportingLedgerStore, REPORTING_LEDGER_MIGRATION } = require('@adcp/reporting-storage');
const { createReportingProducer } = require('@adcp/sdk/reporting/ledger');
const {
  createInlineReportingSourceExecutor,
  redactedReportingSourceOfferingV1,
  redactedReportingSourceRequestV1,
} = require('@adcp/sdk/reporting/source');

const databaseUrl = process.env.REPORTING_LEDGER_PG_URL;
const day = 86_400_000;

describe('PostgreSQL reporting history ownership', { skip: !databaseUrl && 'PostgreSQL URL not set' }, () => {
  const schema = `adcp_reporting_history_${process.pid}`;
  let bootstrap;
  let pool;
  let store;
  let producer;
  const boundary = Math.floor(Date.now() / day) * day;
  const iso = daysAgo => new Date(boundary - daysAgo * day).toISOString();
  function input(accountId) {
    const request = redactedReportingSourceRequestV1();
    return {
      account: { account_id: accountId },
      sourceScope: request.sourceScope,
      delivery_config_id: 'history',
      delivery_config_version: 1,
      offeringId: request.offeringId,
      report_definition_id: request.report_definition_id,
      feedPurpose: 'analytics',
      requiredFinality: 'snapshot',
      requestedMetrics: request.requestedMetrics,
      requestedDimensions: request.requestedDimensions,
      constituents: request.coverage.constituents,
      mediaBuyIds: request.coverage.mediaBuyIds,
      sourceTimezone: 'UTC',
      sourceSettings: request.sourceSettings,
      contract: request.contract,
      schedule: {
        anchor: iso(0),
        periodMilliseconds: day,
        deliverySlaMilliseconds: 21_600_000,
        recoveryWindowMilliseconds: day,
      },
    };
  }
  before(async () => {
    bootstrap = new Pool({ connectionString: databaseUrl });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path="${schema}"` });
    // Start from the published configuration layout, including a durable pre-history row.
    await pool.query(`CREATE TABLE adcp_reporting_configurations (
      configuration_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, delivery_config_id TEXT NOT NULL,
      delivery_config_version INTEGER NOT NULL, semantic_fingerprint TEXT NOT NULL,
      data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL,
      UNIQUE (account_id, delivery_config_id, delivery_config_version))`);
    const legacy = {
      ...input('legacy-history'),
      configurationId: 'legacy-history',
      installedAt: new Date().toISOString(),
      semanticFingerprint: 'sha256:legacy-history',
    };
    await pool.query(
      `INSERT INTO adcp_reporting_configurations VALUES ($1, $2, $3, $4, $5, $6::jsonb, clock_timestamp())`,
      [
        legacy.configurationId,
        legacy.account.account_id,
        legacy.delivery_config_id,
        1,
        legacy.semanticFingerprint,
        JSON.stringify(legacy),
      ]
    );
    await pool.query(REPORTING_LEDGER_MIGRATION);
    await pool.query(REPORTING_LEDGER_MIGRATION);
    store = new PostgresReportingLedgerStore(pool, { acknowledgeIsolatedDatabase: true });
    const offering = structuredClone(redactedReportingSourceOfferingV1);
    producer = createReportingProducer({
      store,
      source: createInlineReportingSourceExecutor(() => [], offering),
      offerings: [offering],
      contact: { name: 'Operations' },
    });
  });
  after(async () => {
    await pool?.end();
    if (bootstrap) {
      await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrap.end();
    }
  });

  test('migrates existing rows idempotently and persists new history on install', async () => {
    const [legacy] = await store.listConfigurations('legacy-history');
    assert.equal(legacy.historyStart, undefined);
    const original = structuredClone(legacy);
    const extended = await producer.extendConfigurationHistory({
      configurationId: legacy.configurationId,
      historyStart: iso(3),
    });
    assert.equal(extended.installedAt, original.installedAt);
    assert.equal(extended.semanticFingerprint, original.semanticFingerprint);
    const installed = await producer.installConfiguration(input('history-install'), { historyStart: iso(4) });
    const persisted = await pool.query(
      'SELECT history_start, data FROM adcp_reporting_configurations WHERE configuration_id = $1',
      [installed.configurationId]
    );
    assert.equal(persisted.rows[0].history_start.toISOString(), iso(4));
    assert.deepEqual(persisted.rows[0].data, installed);
    const reopened = new PostgresReportingLedgerStore(pool, { acknowledgeIsolatedDatabase: true });
    assert.deepEqual((await reopened.listConfigurations('history-install'))[0], installed);
    await assert.rejects(
      store.createSnapshot({
        account_id: 'history-install',
        view: 'summary',
        period: { start: iso(4), end: iso(0) },
      }),
      /missing an elapsed obligation/,
      'unplanned history must count as a gap'
    );
    await producer.planObligations(new Date().toISOString(), { account_id: 'history-install' });
    const planned = await store.createSnapshot({
      account_id: 'history-install',
      view: 'summary',
      period: { start: iso(4), end: iso(0) },
    });
    assert.equal(planned.obligations.length, 4);
  });

  test('preserves requested history during concurrent installation', async () => {
    const configuration = input('history-install-race');
    const requests = [2, 4];
    const outcomes = await Promise.allSettled(
      requests.map(daysAgo => producer.installConfiguration(configuration, { historyStart: iso(daysAgo) }))
    );
    assert.ok(outcomes.some(value => value.status === 'fulfilled'));
    const [stored] = await store.listConfigurations('history-install-race');
    for (let index = 0; index < outcomes.length; index += 1) {
      const outcome = outcomes[index];
      if (outcome.status === 'fulfilled') {
        assert.equal(stored.historyStart, outcome.value.historyStart);
        assert.ok(
          Date.parse(outcome.value.historyStart) <= Date.parse(iso(requests[index])),
          'a successful install must own all requested history'
        );
      } else {
        assert.match(outcome.reason.message, /extendConfigurationHistory/);
      }
    }
  });

  test('normalizes store history boundaries and refuses inconsistent ordinals', async () => {
    const installed = await producer.installConfiguration(input('history-store-boundary'), { historyStart: iso(4) });
    await assert.rejects(
      store.putConfiguration({ ...installed, historyStartOrdinal: installed.historyStartOrdinal + 1 }),
      /schedule ordinal/
    );
    const offset = new Date(Date.parse(iso(5)) - 5 * 3_600_000).toISOString().replace('Z', '-05:00');
    const extended = await store.extendConfigurationHistory({
      configurationId: installed.configurationId,
      historyStart: offset,
      historyStartOrdinal: -5,
    });
    assert.equal(extended.historyStart, iso(5));
    assert.equal((await store.listConfigurations('history-store-boundary'))[0].historyStart, iso(5));
  });

  test('supports indexed live-first claims with a pending history backlog', async () => {
    const client = await pool.connect();
    try {
      await client.query('SET enable_seqscan = off');
      const result = await client.query(
        `EXPLAIN (FORMAT JSON)
        SELECT obligation_id FROM adcp_reporting_obligations
        WHERE state = 'pending' AND account_id = $1 AND next_attempt_at <= $2
          AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
        ORDER BY (COALESCE(data->>'history', 'false') = 'true'), next_attempt_at, obligation_id
        FOR UPDATE SKIP LOCKED LIMIT 1`,
        ['history-install', new Date().toISOString()]
      );
      const nodes = [];
      const walk = node => {
        nodes.push(node);
        for (const child of node.Plans ?? []) walk(child);
      };
      walk(result.rows[0]['QUERY PLAN'][0].Plan);
      assert.ok(
        nodes.some(node => node['Index Name'] === 'adcp_reporting_obligations_account_priority_due'),
        JSON.stringify(nodes)
      );
      assert.ok(
        nodes.every(node => node['Node Type'] !== 'Sort'),
        'priority claims must not sort the complete due backlog'
      );
    } finally {
      await client.query('RESET enable_seqscan');
      client.release();
    }
  });

  test('serializes concurrent extensions without losing earlier ownership or rewriting obligations', async () => {
    const installed = await producer.installConfiguration(input('history-concurrent'), { historyStart: iso(2) });
    await producer.planObligations(new Date().toISOString(), { account_id: 'history-concurrent' });
    const obligations = await store.listObligations('history-concurrent');
    const outcomes = await Promise.allSettled(
      [3, 6, 4].map(daysAgo =>
        producer.extendConfigurationHistory({ configurationId: installed.configurationId, historyStart: iso(daysAgo) })
      )
    );
    assert.equal(outcomes[1].status, 'fulfilled');
    const [persisted] = await store.listConfigurations('history-concurrent');
    assert.equal(persisted.historyStart, iso(6));
    assert.equal(persisted.installedAt, installed.installedAt);
    assert.equal(persisted.semanticFingerprint, installed.semanticFingerprint);
    assert.deepEqual(await store.listObligations('history-concurrent'), obligations);
    await assert.rejects(
      producer.extendConfigurationHistory({ configurationId: installed.configurationId, historyStart: iso(5) }),
      /only move earlier/
    );
    assert.equal(
      (await producer.planObligations(new Date().toISOString(), { account_id: 'history-concurrent' })).length,
      4
    );
  });

  test('prioritizes live claims and excludes history for an exhausted source budget', async () => {
    await producer.installConfiguration(input('history-claims'), { historyStart: iso(5) });
    const now = new Date();
    await producer.planObligations(now.toISOString(), { account_id: 'history-claims' });
    const future = new Date(now.getTime() + 3 * day).toISOString();
    await producer.planObligations(future, { account_id: 'history-claims', maxHistoryObligationsPerSource: 0 });
    const claim = { owner: 'history-priority', account_id: 'history-claims', now: future, leaseMilliseconds: 60_000 };
    const leases = [];
    for (;;) {
      const lease = await store.claimObligation({
        ...claim,
        excludeHistoryOfferingIds: [redactedReportingSourceOfferingV1.offeringId],
      });
      if (!lease) break;
      leases.push(lease);
      assert.equal(lease.obligation.history, undefined);
    }
    assert.ok(leases.length > 0, 'history must not hide eligible live work');
    const historical = await store.claimObligation(claim);
    assert.equal(historical.obligation.history, true);
    for (const lease of [...leases, historical]) await store.releaseObligationLease(lease);
    const first = await store.claimObligation(claim);
    assert.equal(first.obligation.history, undefined, 'live priority also holds without exclusions');
    await store.releaseObligationLease(first);
  });

  test('checks overlap atomically against an installed successor', async () => {
    const configuration = input('history-successor');
    const first = await producer.installConfiguration(configuration, { historyStart: iso(2) });
    const next = { ...configuration, delivery_config_version: 2 };
    await assert.rejects(producer.installConfiguration(next, { historyStart: iso(3) }), error =>
      /overlaps/.test(error.cause?.message ?? error.message)
    );
    const second = await producer.installConfiguration(next);
    await assert.rejects(
      producer.extendConfigurationHistory({ configurationId: second.configurationId, historyStart: iso(3) }),
      error => /overlaps/.test(error.cause?.message ?? error.message)
    );
    const extended = await producer.extendConfigurationHistory({
      configurationId: first.configurationId,
      historyStart: iso(3),
    });
    assert.equal(extended.historyStart, iso(3));
  });
});
