const assert = require('node:assert/strict');
const { after, before, describe, test } = require('node:test');
const { reportingLedgerMigrationForTest } = require('./helpers/reporting-row-storage-mode.js');

const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

describe('issue-lifecycle events over PostgreSQL', { skip: !DATABASE_URL && 'PostgreSQL URL not set' }, () => {
  const tag = `${process.pid}_${Date.now()}`;
  const schemas = [];
  let bootstrap;
  let pools = [];
  let lib;
  let sdk;
  let sourceApi;
  let createReference;
  let createPool;

  before(async () => {
    const { Pool } = require('pg');
    lib = require('./helpers/ledger.js');
    sdk = require('@adcp/sdk/reporting/ledger');
    sourceApi = require('@adcp/sdk/reporting/source');
    ({
      createReportingLifecycleReference: createReference,
    } = require('../examples/reliable-reporting-lifecycle/index.js'));
    bootstrap = new Pool({ connectionString: DATABASE_URL });
    createPool = async name => {
      const schema = `adcp_issue_events_${name}_${tag}`;
      schemas.push(schema);
      await bootstrap.query(`CREATE SCHEMA "${schema}"`);
      const pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path="${schema}"` });
      pools.push(pool);
      return pool;
    };
  });

  after(async () => {
    for (const pool of pools) await pool.end();
    if (bootstrap) {
      for (const schema of schemas) await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await bootstrap.end();
    }
  });

  /** One obligation with one committed revision, as `reporting-status-ingest-pg` builds it. */
  async function world(name, { issueEvents }) {
    const pool = await createPool(name);
    await pool.query(reportingLedgerMigrationForTest(lib));
    if (issueEvents) await pool.query(lib.REPORTING_ISSUE_EVENTS_MIGRATION);
    const reference = createReference({ pool });
    const request = sourceApi.redactedReportingSourceRequestV1();
    const day = 86_400_000;
    const today = new Date();
    const anchorMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 2);
    let configuration = await reference.producer.installConfiguration({
      account: request.account,
      sourceScope: request.sourceScope,
      delivery_config_id: request.delivery_config_id,
      delivery_config_version: request.delivery_config_version,
      offeringId: reference.source.offering.offeringId,
      report_definition_id: request.report_definition_id,
      feedPurpose: 'analytics',
      requiredFinality: 'snapshot',
      requestedMetrics: request.requestedMetrics,
      requestedDimensions: request.requestedDimensions,
      constituents: request.coverage.constituents,
      mediaBuyIds: request.coverage.mediaBuyIds,
      sourceTimezone: 'UTC',
      schedule: {
        anchor: new Date(anchorMs).toISOString().replace('.000Z', '.0001Z'),
        periodMilliseconds: day,
        deliverySlaMilliseconds: 0,
        recoveryWindowMilliseconds: day,
        restatementMilliseconds: [2 * day],
      },
      sourceSettings: request.sourceSettings,
      contract: request.contract,
    });
    configuration = { ...configuration, installedAt: new Date(anchorMs).toISOString() };
    await pool.query('UPDATE adcp_reporting_configurations SET data = $2::jsonb WHERE configuration_id = $1', [
      configuration.configurationId,
      JSON.stringify(configuration),
    ]);
    const [obligation] = await reference.producer.planObligations(new Date(anchorMs + day).toISOString());
    await reference.producer.runWorker({ now: () => new Date(anchorMs + day + 1), maxIterations: 1 });
    const [revision] = await reference.store.listRevisions(obligation.reporting_obligation_id);
    const sync = lib.createSyncReportingStatusHandler(reference.store, {
      resolveConsumerId: context => context.consumer,
    });
    let counter = 0;
    const sent = new Map();
    const w = {
      pool,
      reference,
      request,
      obligation,
      revision,
      configuration,
      anchorMs,
      day,
      store: reference.store,
      /** File one statement as `consumer`; `supersedes` names the consumer's current leaf. */
      async file(consumer, consumerStatus, { supersedes, revisionRow = w.revision, statusId } = {}) {
        counter += 1;
        const id = statusId ?? `issue-status-${name}-${consumer}-${counter}`;
        const evidence = {
          received: {
            reporting_obligation_id: obligation.reporting_obligation_id,
            reporting_revision_id: revisionRow.reporting_revision_id,
            observed_revision_content_sha256: revisionRow.wireRevision.revision_content_sha256,
          },
          revision_missing: { reporting_obligation_id: obligation.reporting_obligation_id },
          unreadable: {
            reporting_obligation_id: obligation.reporting_obligation_id,
            reporting_revision_id: revisionRow.reporting_revision_id,
            failure_code: 'integrity_mismatch',
          },
        }[consumerStatus];
        const input = {
          account: request.account,
          idempotency_key: `key-${id}`,
          statuses: [
            {
              reporting_status_id: id,
              ...(supersedes ? { supersedes_reporting_status_id: supersedes } : {}),
              delivery_config_id: obligation.delivery_config_id,
              delivery_config_version: obligation.delivery_config_version,
              report_definition_id: obligation.report_definition_id,
              period: {
                start: obligation.period.start,
                end: obligation.period.end,
                source_timezone: obligation.period.sourceTimezone,
              },
              consumer_status: consumerStatus,
              status_as_of: new Date().toISOString(),
              ...evidence,
            },
          ],
        };
        const context = { account: request.account, consumer };
        sent.set(consumer, { input, context });
        const response = await sync(input, context);
        assert.equal(response.results[0].result, 'recorded', JSON.stringify(response));
        return id;
      },
      /** Resend the consumer's last batch: exactly (same key) or as a new batch (`unchanged`). */
      async resend(consumer, { newKey = false } = {}) {
        const { input, context } = sent.get(consumer);
        const response = await sync(
          newKey ? { ...input, idempotency_key: `${input.idempotency_key}-again` } : input,
          context
        );
        return response.results[0].result;
      },
      async events(consumer) {
        const result = await pool.query(
          `SELECT event_id, kind, issue_id, consumer_id, reporting_status_id, occurred_at, attempts, delivered_at
             FROM adcp_reporting_issue_events WHERE consumer_id = $1 ORDER BY seq`,
          [consumer]
        );
        return result.rows;
      },
      async kinds(consumer) {
        return (await w.events(consumer)).map(row => row.kind);
      },
      async restate() {
        reference.source.restate([{ media_buy_id: request.coverage.mediaBuyIds[0], impressions: 12, spend: '1.20' }]);
        await reference.producer.runWorker({
          now: () => new Date(anchorMs + 3 * day),
          maxIterations: 1,
        });
        const revisions = await reference.store.listRevisions(obligation.reporting_obligation_id);
        assert.equal(revisions.length, 2);
        return revisions;
      },
      /** Claim and complete everything pending, so a test starts from an empty outbox. */
      async drain() {
        for (;;) {
          const leases = await w.store.claimIssueEvents({ leaseMilliseconds: 60_000, limit: 100 });
          if (leases.length === 0) return;
          for (const lease of leases) await w.store.completeIssueEvent(lease);
        }
      },
    };
    return w;
  }

  describe('migration 0012', () => {
    test('is additive: one table plus indexes, and migrate() applies it', async () => {
      const sql = lib.REPORTING_ISSUE_EVENTS_MIGRATION;
      assert.equal((sql.match(/CREATE TABLE/g) ?? []).length, 1);
      assert.doesNotMatch(sql, /\b(ALTER|DROP|UPDATE|DELETE)\b/);
      const entry = lib.migrations().find(item => item.version === '0012');
      assert.equal(entry.name, 'reporting_issue_events');
      assert.deepEqual(entry.statements(), [sql]);
      assert.ok(!entry.stoppedWorker, 'earlier-release workers run beside it');

      const pool = await createPool('migrate');
      assert.equal(
        await new lib.PostgresReportingLedgerStore(pool, { acknowledgeIsolatedDatabase: true }).issueEventsReady(),
        false
      );
      const applied = await lib.migrate(pool);
      assert.ok(applied.some(item => item.version === '0012'));
      const recorded = await lib.appliedMigrations(pool);
      assert.ok(recorded.has('0012'));
      assert.equal(
        await new lib.PostgresReportingLedgerStore(pool, { acknowledgeIsolatedDatabase: true }).issueEventsReady(),
        true
      );
      const indexes = await pool.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'adcp_reporting_issue_events'`
      );
      for (const name of [
        'pending',
        'account_pending',
        'issue_pending',
        'delivered',
        'obligation_opened',
        'statement_opened',
      ]) {
        assert.ok(
          indexes.rows.some(row => row.indexname === `adcp_reporting_issue_events_${name}`),
          name
        );
      }
      assert.deepEqual(await lib.migrate(pool), [], 'idempotent');
      await pool.query(sql);
    });

    test('with the table absent, ingest and commit still work and record nothing; installing it turns recording on', async () => {
      const w = await world('absent', { issueEvents: false });
      const store = w.store;
      assert.equal(await store.issueEventsReady(), false);
      assert.equal(
        (await w.pool.query("SELECT to_regclass('adcp_reporting_issue_events') AS present")).rows[0].present,
        null
      );

      await w.file('absent-consumer', 'received'); // ingest works
      await w.restate(); // commit works, and the statement is now stale
      assert.equal(await store.sweepIssueEscalations({ escalationSeconds: 0 }), 0);
      assert.deepEqual(await store.claimIssueEvents({ leaseMilliseconds: 1_000, limit: 10 }), []);
      assert.equal(await store.pruneIssueEvents({ olderThanMilliseconds: 0 }), 0);
      assert.equal(
        (await w.pool.query("SELECT to_regclass('adcp_reporting_issue_events') AS present")).rows[0].present,
        null
      );

      await w.pool.query(lib.REPORTING_ISSUE_EVENTS_MIGRATION);
      // The cache only remembers "installed", so the same store notices the table.
      assert.equal(await store.issueEventsReady(), true);
      await w.file('absent-consumer-2', 'revision_missing');
      assert.deepEqual(await w.kinds('absent-consumer-2'), ['opened']);
    });
  });

  describe('period retirement', () => {
    test('retiring a period resolves its open occurrences, deletes no outbox rows, and the occurrence is then pruned whole', async () => {
      const w = await world('retire', { issueEvents: true });
      const obligationId = w.obligation.reporting_obligation_id;
      // A: opened, escalated, both delivered. B: opened, still undelivered.
      await w.file('retire-a', 'revision_missing');
      assert.equal(await w.store.sweepIssueEscalations({ escalationSeconds: 0 }), 1);
      await w.drain();
      assert.deepEqual(await w.kinds('retire-a'), ['opened', 'escalated']);
      await w.file('retire-b', 'revision_missing');

      // Make the period retirable: ended long ago, no worker, publications older than the retention.
      await w.pool.query(
        `UPDATE adcp_reporting_obligations
            SET period_start = period_start - INTERVAL '40 days', period_end = period_end - INTERVAL '40 days',
                created_at = created_at - INTERVAL '40 days', state = 'terminal',
                lease_expires_at = clock_timestamp() - INTERVAL '1 second'
          WHERE obligation_id = $1`,
        [obligationId]
      );
      await w.pool.query(
        `UPDATE adcp_reporting_revisions SET recorded_at = recorded_at - INTERVAL '40 days' WHERE obligation_id = $1`,
        [obligationId]
      );
      let retired = 0;
      for (let pass = 0; pass < 5 && retired === 0; pass += 1) {
        retired = (await w.store.retireExpiredPeriods({ statusRetentionDays: 30 })).retired;
      }
      assert.equal(retired, 1);
      const gone = await w.pool.query('SELECT 1 FROM adcp_reporting_obligations WHERE obligation_id = $1', [
        obligationId,
      ]);
      assert.equal(gone.rowCount, 0);
      const tombstone = await w.pool.query(
        'SELECT state FROM adcp_reporting_obligation_tombstones WHERE obligation_id = $1',
        [obligationId]
      );
      assert.equal(tombstone.rows[0].state, 'retired');

      // The retirement transaction resolved every open occurrence of the obligation.
      const a = await w.events('retire-a');
      assert.deepEqual(
        a.map(row => row.kind),
        ['opened', 'escalated', 'resolved']
      );
      assert.equal(a[2].delivered_at, null, 'resolved is undelivered');
      assert.ok(a[2].occurred_at);
      assert.equal(a[2].issue_id, a[0].issue_id);
      // Control: retirement deletes no outbox rows. B's undelivered `opened` is intact, then its `resolved`.
      const b = await w.events('retire-b');
      assert.deepEqual(
        b.map(row => row.kind),
        ['opened', 'resolved']
      );
      assert.ok(b.every(row => row.delivered_at === null));
      const claimed = await w.store.claimIssueEvents({ leaseMilliseconds: 60_000, limit: 100 });
      const claimedB = claimed.filter(lease => lease.consumerId === 'retire-b');
      assert.deepEqual(
        claimedB.map(lease => lease.kind),
        ['opened'],
        'resolved waits for opened'
      );
      for (const lease of claimed)
        assert.equal(await w.store.releaseIssueEvent(lease, { retryAfterMilliseconds: 0 }), true);

      // The dispatcher delivers the resolved event with no issue and no principal, B in recording order.
      const seen = [];
      const dispatcher = sdk.createReportingIssueEventDispatcherV1({
        store: w.store,
        observer: event => void seen.push(event),
      });
      await dispatcher.runOnce({ accountId: w.request.account.account_id });
      const resolvedA = seen.find(event => event.consumerId === 'retire-a' && event.kind === 'resolved');
      assert.ok(resolvedA, 'resolved was delivered');
      assert.equal(resolvedA.issue, null);
      assert.equal('principal' in resolvedA, false);
      assert.deepEqual(
        seen.filter(event => event.consumerId === 'retire-b').map(event => event.kind),
        ['opened', 'resolved']
      );
      assert.ok((await w.events('retire-a')).every(row => row.delivered_at !== null));

      // Delivered past the retention, the closed occurrence is pruned whole.
      await w.pool.query(
        `UPDATE adcp_reporting_issue_events SET delivered_at = clock_timestamp() - INTERVAL '8 days' WHERE consumer_id = 'retire-a'`
      );
      assert.equal(await w.store.pruneIssueEvents({ olderThanMilliseconds: 7 * 86_400_000 }), 3);
      assert.deepEqual(await w.events('retire-a'), []);
      assert.equal((await w.events('retire-b')).length, 2, 'the other occurrence is inside the retention');
    });
  });

  describe('lifecycle', () => {
    let w;
    let keptEventIds = [];
    before(async () => {
      w = await world('main', { issueEvents: true });
    });

    test('issueEventsReady is true and an agreeing received statement records nothing', async () => {
      assert.equal(w.store.issueEventsSupported, true);
      assert.equal(sdk.supportsReportingIssueEventsV1(w.store), true);
      assert.equal(await w.store.issueEventsReady(), true);
      await w.file('agrees', 'received');
      assert.deepEqual(await w.events('agrees'), []);
    });

    for (const negative of ['revision_missing', 'unreadable']) {
      test(`a ${negative} status opens at ingest, exactly once per replay`, async () => {
        const consumer = `negative-${negative}`;
        const id = await w.file(consumer, negative);
        const [opened, ...rest] = await w.events(consumer);
        assert.equal(rest.length, 0);
        assert.equal(opened.kind, 'opened');
        assert.equal(opened.reporting_status_id, id);
        assert.equal(opened.event_id, sdk.reportingIssueEventIdV1(opened.issue_id, opened.consumer_id, 'opened'));
        // An exact batch replay and an unchanged status in a new batch record nothing more.
        assert.equal(await w.resend(consumer), 'recorded');
        assert.equal(await w.resend(consumer, { newKey: true }), 'unchanged');
        assert.deepEqual(await w.kinds(consumer), ['opened']);
      });
    }

    test('superseding with an agreeing statement resolves the old occurrence', async () => {
      const first = await w.file('supersede-agree', 'revision_missing');
      await w.file('supersede-agree', 'received', { supersedes: first });
      const events = await w.events('supersede-agree');
      assert.deepEqual(
        events.map(row => row.kind),
        ['opened', 'resolved']
      );
      assert.equal(events[1].issue_id, events[0].issue_id);
      assert.ok(
        sdk.compareReportingInstants(events[1].occurred_at, events[0].occurred_at) >= 0,
        'never resolved before it opened'
      );
    });

    test('superseding with another conflicting statement resolves the old one and opens a new one', async () => {
      const first = await w.file('supersede-conflict', 'revision_missing');
      await w.file('supersede-conflict', 'unreadable', { supersedes: first });
      const events = await w.events('supersede-conflict');
      assert.deepEqual(
        events.map(row => row.kind),
        ['opened', 'resolved', 'opened']
      );
      assert.equal(events[1].issue_id, events[0].issue_id);
      assert.notEqual(events[2].issue_id, events[0].issue_id);
    });

    test('only opened, escalated and resolved are ever recorded', async () => {
      const all = await w.pool.query('SELECT DISTINCT kind FROM adcp_reporting_issue_events');
      for (const { kind } of all.rows) assert.ok(['opened', 'escalated', 'resolved'].includes(kind), kind);
    });

    test('escalation: none before the boundary, exact at it, once, and not for a resolved occurrence', async () => {
      await w.file('esc-open', 'revision_missing');
      const resolvedFirst = await w.file('esc-resolved', 'revision_missing');
      await w.file('esc-resolved', 'received', { supersedes: resolvedFirst });
      assert.equal(
        await w.store.sweepIssueEscalations({ escalationSeconds: 3_600, accountId: w.request.account.account_id }),
        0
      );

      const [opened] = await w.events('esc-open');
      const ONE_SECOND = 1;
      await sleep(1_100);
      assert.ok((await w.store.sweepIssueEscalations({ escalationSeconds: ONE_SECOND })) >= 1);
      const escalated = (await w.events('esc-open')).filter(row => row.kind === 'escalated');
      assert.equal(escalated.length, 1);
      assert.equal(escalated[0].issue_id, opened.issue_id);
      assert.equal(
        escalated[0].occurred_at,
        sdk.reportingIssueEscalationV1(
          {
            ...opened,
            eventId: opened.event_id,
            issueId: opened.issue_id,
            accountId: w.request.account.account_id,
            consumerId: 'esc-open',
            reportingObligationId: w.obligation.reporting_obligation_id,
            reportingStatusId: opened.reporting_status_id,
            occurredAt: opened.occurred_at,
          },
          ONE_SECOND,
          '2100-01-01T00:00:00Z'
        ).occurredAt
      );
      await w.store.sweepIssueEscalations({ escalationSeconds: ONE_SECOND });
      assert.equal((await w.events('esc-open')).filter(row => row.kind === 'escalated').length, 1, 'exactly once');
      assert.deepEqual(await w.kinds('esc-resolved'), ['opened', 'resolved'], 'a resolved occurrence is not escalated');
    });

    test('the sweep settles first: a cleared condition resolves instead of escalating', async () => {
      // Seed an open occurrence for a leaf that agrees with the ledger.
      const id = await w.file('sweep-clears', 'received');
      assert.deepEqual(await w.events('sweep-clears'), []);
      const issueId = 'rpti_seeded_sweep';
      await w.pool.query(
        `INSERT INTO adcp_reporting_issue_events
           (event_id, account_id, consumer_id, issue_id, obligation_id, reporting_status_id, kind, occurred_at)
         VALUES ($1, $2, 'sweep-clears', $3, $4, $5, 'opened', $6)`,
        [
          sdk.reportingIssueEventIdV1(issueId, 'sweep-clears', 'opened'),
          w.request.account.account_id,
          issueId,
          w.obligation.reporting_obligation_id,
          id,
          new Date(Date.now() - 10_000).toISOString(),
        ]
      );
      await w.store.sweepIssueEscalations({ escalationSeconds: 0 });
      assert.deepEqual(await w.kinds('sweep-clears'), ['opened', 'resolved']);
    });

    test('exactly-once escalation across 4 concurrent sweeps', async () => {
      const consumers = ['sweep-a', 'sweep-b', 'sweep-c'];
      for (const consumer of consumers) await w.file(consumer, 'revision_missing');
      const recorded = await Promise.all(
        [1, 2, 3, 4].map(() => w.store.sweepIssueEscalations({ escalationSeconds: 0 }))
      );
      assert.ok(recorded.reduce((sum, value) => sum + value, 0) >= consumers.length);
      for (const consumer of consumers) {
        const kinds = await w.kinds(consumer);
        assert.deepEqual(kinds, ['opened', 'escalated'], consumer);
      }
      const duplicates = await w.pool.query(
        'SELECT issue_id, kind FROM adcp_reporting_issue_events GROUP BY issue_id, kind HAVING COUNT(*) > 1'
      );
      assert.equal(duplicates.rowCount, 0);
    });

    test('concurrent claims are disjoint and one occurrence leases one event at a time, in order', async () => {
      await w.drain();
      const consumers = ['claim-a', 'claim-b', 'claim-c', 'claim-d', 'claim-e', 'claim-f'];
      for (const consumer of consumers) await w.file(consumer, 'revision_missing');
      // `claim-a` also resolves, so it holds two events on one occurrence.
      const [aEvent] = await w.events('claim-a');
      await w.file('claim-a', 'received', { supersedes: aEvent.reporting_status_id });

      const batches = await Promise.all(
        [1, 2, 3].map(() => w.store.claimIssueEvents({ leaseMilliseconds: 60_000, limit: 3 }))
      );
      const claimed = batches.flat();
      assert.equal(new Set(claimed.map(lease => lease.eventId)).size, claimed.length, 'disjoint');
      assert.equal(new Set(claimed.map(lease => lease.issueId)).size, claimed.length, 'one per occurrence');
      assert.ok(claimed.length >= 1 && claimed.length <= 9);
      for (const lease of claimed) {
        assert.equal(lease.attempts, 1);
        assert.ok(lease.leaseToken);
        if (lease.consumerId === 'claim-a') assert.equal(lease.kind, 'opened', 'recording order');
      }
      for (const lease of claimed) assert.equal(await w.store.completeIssueEvent(lease), true);
      // The resolution is claimable only once its `opened` was delivered.
      let seenResolved = false;
      for (let round = 0; round < 10 && !seenResolved; round += 1) {
        const leases = await w.store.claimIssueEvents({ leaseMilliseconds: 60_000, limit: 100 });
        for (const lease of leases) {
          if (lease.kind === 'resolved' && lease.consumerId === 'claim-a') seenResolved = true;
          await w.store.completeIssueEvent(lease);
        }
        if (leases.length === 0) break;
      }
      assert.ok(seenResolved);
      await w.drain();
    });

    test('an expired lease is reclaimed with attempt 2 and the stale lease cannot complete', async () => {
      await w.drain();
      await w.file('lease-consumer', 'revision_missing');
      const [first] = await w.store.claimIssueEvents({
        leaseMilliseconds: 200,
        limit: 1,
        accountId: w.request.account.account_id,
      });
      assert.equal(first.consumerId, 'lease-consumer');
      assert.deepEqual(await w.store.claimIssueEvents({ leaseMilliseconds: 200, limit: 1 }), []);
      await sleep(300);
      const [again] = await w.store.claimIssueEvents({ leaseMilliseconds: 60_000, limit: 1 });
      assert.equal(again.eventId, first.eventId);
      assert.equal(again.attempts, 2);
      assert.equal(await w.store.completeIssueEvent(first), false);
      assert.equal(await w.store.releaseIssueEvent(first, { retryAfterMilliseconds: 0 }), false);
      assert.equal(await w.store.completeIssueEvent(again), true);
    });

    test('release backs the event off: not claimable before the delay, claimable after', async () => {
      await w.drain();
      await w.file('release-consumer', 'revision_missing');
      const [lease] = await w.store.claimIssueEvents({ leaseMilliseconds: 60_000, limit: 1 });
      assert.equal(await w.store.releaseIssueEvent(lease, { retryAfterMilliseconds: 600 }), true);
      assert.deepEqual(await w.store.claimIssueEvents({ leaseMilliseconds: 60_000, limit: 1 }), []);
      await sleep(700);
      const [again] = await w.store.claimIssueEvents({ leaseMilliseconds: 60_000, limit: 1 });
      assert.equal(again.eventId, lease.eventId);
      assert.equal(again.attempts, 2);
      await w.store.completeIssueEvent(again);
    });

    const eventIds = async consumer => (await w.events(consumer)).map(row => row.event_id);
    const backdate = (consumer, { occurredDays, deliveredDays }) =>
      w.pool.query(
        `UPDATE adcp_reporting_issue_events
            SET occurred_at = to_char((clock_timestamp() - make_interval(days => $2)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                delivered_at = CASE WHEN delivered_at IS NULL THEN NULL ELSE clock_timestamp() - make_interval(days => $3) END
          WHERE consumer_id = $1 AND kind = 'opened'`,
        [consumer, occurredDays, deliveredDays]
      );

    test('prune never deletes an open occurrence; once superseded it goes whole, and pending events are kept', async () => {
      await w.drain();
      await sleep(30);
      await w.store.pruneIssueEvents({ olderThanMilliseconds: 10 }); // earlier tests' closed occurrences
      await w.file('prune-open', 'revision_missing');
      const pendingFirst = await w.file('prune-pending', 'revision_missing');
      const leases = await w.store.claimIssueEvents({ leaseMilliseconds: 60_000, limit: 100 });
      const mine = leases.find(lease => lease.consumerId === 'prune-open');
      assert.equal(await w.store.completeIssueEvent(mine), true);
      // `prune-pending`'s lease lapses undelivered below; it is not claimed again here.
      await sleep(30);
      assert.equal(await w.store.pruneIssueEvents({ olderThanMilliseconds: 0 }), 0, 'an open occurrence stays');
      assert.deepEqual(await w.kinds('prune-open'), ['opened']);
      // The buyer supersedes it with an agreeing statement: `resolved` is recorded.
      const [openedRow] = await w.events('prune-open');
      await w.file('prune-open', 'received', { supersedes: openedRow.reporting_status_id });
      assert.deepEqual(await w.kinds('prune-open'), ['opened', 'resolved']);
      const before = await eventIds('prune-open');
      await sleep(30);
      assert.equal(await w.store.pruneIssueEvents({ olderThanMilliseconds: 0 }), 0, 'resolved but not yet delivered');
      for (const lease of await w.store.claimIssueEvents({ leaseMilliseconds: 60_000, limit: 100 })) {
        if (lease.consumerId === 'prune-open') assert.equal(await w.store.completeIssueEvent(lease), true);
        else await w.store.releaseIssueEvent(lease, { retryAfterMilliseconds: 0 });
      }
      await sleep(30);
      assert.equal(await w.store.pruneIssueEvents({ olderThanMilliseconds: 3_600_000 }), 0, 'inside the retention');
      assert.ok((await w.store.pruneIssueEvents({ olderThanMilliseconds: 10 })) >= 2);
      assert.deepEqual(await w.events('prune-open'), [], 'the whole occurrence went');
      assert.equal(before.length, 2);
      assert.ok((await w.kinds('prune-pending')).length >= 1, 'an undelivered open occurrence is kept');
      void pendingFirst;
      await w.drain();
    });

    test('an escalation window longer than the retention still escalates after the opened event was pruned-eligible', async () => {
      await w.drain();
      await w.file('long-window', 'revision_missing');
      await w.drain(); // `opened` delivered
      await backdate('long-window', { occurredDays: 15, deliveredDays: 8 });
      // Delivered 8 days ago against a 7-day retention, but the occurrence is open: nothing goes.
      assert.equal(await w.store.pruneIssueEvents({ olderThanMilliseconds: 7 * 86_400_000 }), 0);
      assert.deepEqual(await w.kinds('long-window'), ['opened']);
      // The 10-day window passed (opened 15 days ago): the sweep still finds it and records `escalated` once.
      const tenDays = 10 * 86_400;
      assert.ok((await w.store.sweepIssueEscalations({ escalationSeconds: tenDays })) >= 1);
      assert.equal(await w.store.sweepIssueEscalations({ escalationSeconds: tenDays }), 0);
      assert.deepEqual(await w.kinds('long-window'), ['opened', 'escalated']);
      const [opened, escalated] = await w.events('long-window');
      assert.equal(
        escalated.occurred_at,
        require('../../../dist/lib/reporting/ledger/instant.js').addReportingInstantOffset(
          opened.occurred_at,
          tenDays * 1_000
        )
      );
      await w.drain();
    });

    test('a resolved occurrence whose statement is still current is kept, so its event ids are never recreated', async () => {
      await w.drain();
      const id = await w.file('keep-anchor', 'received'); // agrees with the ledger: no event
      assert.deepEqual(await w.events('keep-anchor'), []);
      const issueId = 'rpti_seeded_keep';
      await w.pool.query(
        `INSERT INTO adcp_reporting_issue_events
           (event_id, account_id, consumer_id, issue_id, obligation_id, reporting_status_id, kind, occurred_at)
         VALUES ($1, $2, 'keep-anchor', $3, $4, $5, 'opened', $6)`,
        [
          sdk.reportingIssueEventIdV1(issueId, 'keep-anchor', 'opened'),
          w.request.account.account_id,
          issueId,
          w.obligation.reporting_obligation_id,
          id,
          new Date(Date.now() - 10_000).toISOString(),
        ]
      );
      await w.store.sweepIssueEscalations({ escalationSeconds: 0 }); // settles first: resolves it
      assert.deepEqual(await w.kinds('keep-anchor'), ['opened', 'resolved']);
      await w.drain();
      await sleep(30);
      await w.store.pruneIssueEvents({ olderThanMilliseconds: 10 });
      assert.deepEqual(await w.kinds('keep-anchor'), ['opened', 'resolved'], 'the anchor stays');
      keptEventIds = await eventIds('keep-anchor');
    });

    test('two consumers filing the same status id get independent occurrences', async () => {
      await w.drain();
      const shared = 'issue-status-shared-between-consumers';
      await w.file('twin-1', 'revision_missing', { statusId: shared });
      await w.file('twin-2', 'revision_missing', { statusId: shared });
      const [one] = await w.events('twin-1');
      const [two] = await w.events('twin-2');
      assert.equal(one.kind, 'opened');
      assert.equal(two.kind, 'opened');
      assert.equal(one.issue_id, two.issue_id, 'same issue id');
      assert.notEqual(one.event_id, two.event_id);
      assert.equal(one.event_id, sdk.reportingIssueEventIdV1(one.issue_id, 'twin-1', 'opened'));
      assert.equal(two.event_id, sdk.reportingIssueEventIdV1(two.issue_id, 'twin-2', 'opened'));
      // Both are claimable together: one event per consumer occurrence.
      const claimed = await w.store.claimIssueEvents({ leaseMilliseconds: 60_000, limit: 100 });
      assert.deepEqual(
        claimed
          .filter(lease => lease.issueId === one.issue_id)
          .map(lease => lease.consumerId)
          .sort(),
        ['twin-1', 'twin-2']
      );
      for (const lease of claimed) await w.store.completeIssueEvent(lease);
      // twin-1 resolves; twin-2 stays open and escalates.
      await w.file('twin-1', 'received', { supersedes: shared });
      assert.deepEqual(await w.kinds('twin-1'), ['opened', 'resolved']);
      assert.deepEqual(await w.kinds('twin-2'), ['opened']);
      await w.store.sweepIssueEscalations({ escalationSeconds: 0 });
      assert.deepEqual(await w.kinds('twin-1'), ['opened', 'resolved'], 'a resolved occurrence is not escalated');
      assert.deepEqual(await w.kinds('twin-2'), ['opened', 'escalated']);
      await w.drain();
    });

    test('opened and resolved events carry the obligation principal', async () => {
      await w.drain();
      const obligationId = w.obligation.reporting_obligation_id;
      const subscription = {
        tenantId: 'tenant-1',
        principalId: 'principal-1',
        subscriptionId: w.obligation.delivery_config_id,
        offeringId: w.configuration.offeringId,
        ownership: 'owed_set',
      };
      // File first: a subscription-owned obligation changes how statements are matched on ingest.
      const first = await w.file('principal-consumer', 'revision_missing');
      await w.file('principal-consumer', 'received', { supersedes: first });
      await w.pool.query(
        `UPDATE adcp_reporting_obligations SET data = jsonb_set(data, '{subscription}', $2::jsonb) WHERE obligation_id = $1`,
        [obligationId, JSON.stringify(subscription)]
      );
      try {
        const seen = [];
        const dispatcher = sdk.createReportingIssueEventDispatcherV1({
          store: w.store,
          observer: event => void seen.push(event),
        });
        await dispatcher.runOnce({ accountId: w.request.account.account_id });
        const all = seen.filter(event => event.consumerId === 'principal-consumer');
        assert.deepEqual(
          all.map(event => event.kind),
          ['opened', 'resolved']
        );
        for (const event of all)
          assert.deepEqual(event.principal, { tenantId: 'tenant-1', principalId: 'principal-1' });
      } finally {
        await w.pool.query(
          `UPDATE adcp_reporting_obligations SET data = data - 'subscription' WHERE obligation_id = $1`,
          [obligationId]
        );
      }
    });

    test('accountId scopes claims and sweeps', async () => {
      await w.drain();
      await w.file('scope-consumer', 'revision_missing');
      assert.deepEqual(
        await w.store.claimIssueEvents({ leaseMilliseconds: 60_000, limit: 10, accountId: 'another-account' }),
        []
      );
      assert.equal(await w.store.sweepIssueEscalations({ escalationSeconds: 0, accountId: 'another-account' }), 0);
      const mine = await w.store.claimIssueEvents({
        leaseMilliseconds: 60_000,
        limit: 10,
        accountId: w.request.account.account_id,
      });
      assert.ok(mine.some(lease => lease.consumerId === 'scope-consumer'));
      assert.ok(mine.every(lease => lease.accountId === w.request.account.account_id));
      for (const lease of mine) await w.store.completeIssueEvent(lease);
      await w.drain();
    });

    test('the dispatcher renders and delivers an opened event through the PostgreSQL store', async () => {
      await w.drain();
      await w.file('dispatch-consumer', 'revision_missing');
      const seen = [];
      const dispatcher = sdk.createReportingIssueEventDispatcherV1({
        store: w.store,
        observer: event => void seen.push(event),
      });
      const turn = await dispatcher.runOnce({ accountId: w.request.account.account_id });
      assert.ok(turn.delivered >= 1);
      const event = seen.find(value => value.consumerId === 'dispatch-consumer');
      assert.equal(event.kind, 'opened');
      assert.equal(event.attempt, 1);
      assert.equal(event.accountId, w.request.account.account_id);
      assert.equal(event.reportingObligationId, w.obligation.reporting_obligation_id);
      // This fixture owes an overdue restatement, so the seller's own projection is degraded at the
      // event's instant and `get_reporting_status` would publish the seller's issue instead: the
      // consumer-mismatch issue is suppressed, hence `null` (the occurrence itself stays open).
      const health = sdk.projectReportingObligationHealthV1(
        await w.store.getObligation(w.obligation.reporting_obligation_id, w.request.account.account_id),
        await w.store.listRevisionMetadata(w.obligation.reporting_obligation_id, w.request.account.account_id),
        event.occurredAt
      ).health;
      assert.notEqual(health, 'healthy');
      assert.equal(event.issue, null);
    });

    // Under today's TS projection a real restatement can't clear a mismatch (adcp-client#3653), so this
    // seeds an open occurrence for a leaf that does not conflict (its statement is absent) and pins that
    // commitRevision's settle branch is wired: the commit resolves what the projection no longer reports.
    test('commitRevision resolves an open occurrence whose leaf no longer conflicts (resolve-on-restatement)', async () => {
      const issueId = 'rpti_seeded_commit';
      await w.pool.query(
        `INSERT INTO adcp_reporting_issue_events
           (event_id, account_id, consumer_id, issue_id, obligation_id, reporting_status_id, kind, occurred_at)
         VALUES ($1, $2, 'commit-resolves', $3, $4, 'status-that-does-not-exist', 'opened', $5)`,
        [
          sdk.reportingIssueEventIdV1(issueId, 'commit-resolves', 'opened'),
          w.request.account.account_id,
          issueId,
          w.obligation.reporting_obligation_id,
          new Date(Date.now() - 10_000).toISOString(),
        ]
      );
      await w.file('restate-stale', 'received');
      assert.deepEqual(await w.events('restate-stale'), []);
      await w.restate();
      assert.deepEqual(await w.kinds('commit-resolves'), ['opened', 'resolved'], 'resolved by the commit');
      const [, resolved] = await w.events('commit-resolves');
      assert.ok(sdk.compareReportingInstants(resolved.occurred_at, new Date(Date.now() - 10_000).toISOString()) >= 0);
    });

    test('no event id the prune left behind was recreated by the commit', async () => {
      for (const eventId of keptEventIds) {
        const rows = await w.pool.query('SELECT 1 FROM adcp_reporting_issue_events WHERE event_id = $1', [eventId]);
        assert.equal(rows.rowCount, 1, eventId);
      }
      assert.equal(keptEventIds.length, 2);
    });

    // Last: the restatement changed every `received` leaf filed against the first revision.
    test('the restatement made the received statement stale: opened by commitRevision', async () => {
      const events = await w.events('restate-stale');
      assert.deepEqual(
        events.map(row => row.kind),
        ['opened']
      );
    });
  });
});
