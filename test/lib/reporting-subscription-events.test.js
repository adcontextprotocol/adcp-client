/**
 * Buyer reporting events (experimental `media_buy.reporting_subscriptions`, AdCP 3.3): `poll`,
 * `events` and `handleWebhook`, derived from durable snapshots against the test kit's managed seller.
 */
const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

process.env.NODE_ENV = 'test';

const {
  InMemoryReportingEventStore,
  ReportingClient,
  ReportingEventConflictError,
  VerifiedWebhook,
  createReportingEventStore,
} = require('@adcp/sdk');
const { deriveEvents, EVENT_TYPES } = require('@adcp/sdk/reporting/advanced');
const { InMemoryStateStore } = require('@adcp/sdk/server');
const { memoryStorage } = require('@adcp/sdk/storage');
const { createReportingTestKit, offerings, reportingTestStart } = require('../../dist/lib/testing/reporting/index.js');

const START = reportingTestStart(30);
const day = n => new Date(Date.parse(START) + n * 86_400_000).toISOString();
const analyticsDaily = {
  subscription_id: 'analytics-daily',
  scope: { all_authorized_accounts: true },
  selector: { feed_purpose: 'analytics', period_duration: 'P1D', required_finality: 'snapshot' },
  reconciliation_mode: 'delivery_only',
};

function kit() {
  return createReportingTestKit({
    start: START,
    offerings: [offerings.dailyAnalytics()],
    accounts: [{ account_id: 'acc_a', timezone: 'America/New_York', grants: ['agency-x'] }],
    buys: [
      { media_buy_id: 'mb_1', account_id: 'acc_a', confirmed_at: day(0.6), start_time: day(1), end_time: day(25) },
    ],
  });
}

const types = batch => batch.events.map(event => event.type).sort();

describe('client.reporting.poll', () => {
  test('the first poll reports the present; an un-acked repoll repeats the ids; ack moves on', async () => {
    const k = kit();
    const buyer = k.buyer('agency-x');
    await buyer.reporting.subscribe(analyticsDaily);
    await k.clock.advance('P3D');
    const batch = await buyer.reporting.poll({ now: k.clock.now() });
    assert.deepEqual(types(batch), [
      'account.covered',
      'revision.available',
      'revision.available',
      'subscription.state_changed',
    ]);
    const revision = batch.events.find(event => event.type === 'revision.available');
    assert.equal(revision.data.account_id, 'acc_a');
    assert.ok(revision.data.reporting_revision_id);
    assert.match(revision.id, /^rse_[0-9a-f]{40}$/);
    assert.equal(revision.agent_id, 'reference-seller');
    for (const event of batch.events) assert.ok(EVENT_TYPES.includes(event.type));

    const again = await buyer.reporting.poll({ now: k.clock.now() });
    assert.deepEqual(
      again.events.map(event => event.id),
      batch.events.map(event => event.id),
      'not acked: the same events with the same ids'
    );
    await again.ack();
    assert.equal(again.acked, true);
    const after = await buyer.reporting.poll({ now: k.clock.now() });
    assert.deepEqual(after.events, []);
    await assert.rejects(batch.ack(), ReportingEventConflictError, 'a stale batch cannot be acknowledged');
  });

  test('baseline records the present silently; later deliveries are revision.available', async () => {
    const k = kit();
    const buyer = k.buyer('agency-x');
    await buyer.reporting.subscribe(analyticsDaily);
    await k.clock.advance('P2D');
    const first = await buyer.reporting.poll({ baseline: true, now: k.clock.now() });
    assert.deepEqual(first.events, []);
    assert.equal(first.report.definitive, true);
    await first.ack();
    await k.clock.advance('P1D');
    const next = await buyer.reporting.poll({ now: k.clock.now() });
    assert.deepEqual(types(next), ['revision.available']);
    assert.equal(next.events[0].data.period.start, day(2));
  });

  test('losing and regaining authority are account.unauthorized, then account.regranted', async () => {
    const k = kit();
    const buyer = k.buyer('agency-x');
    await buyer.reporting.subscribe(analyticsDaily);
    await k.clock.advance('P2D');
    await (await buyer.reporting.poll({ now: k.clock.now() })).ack();
    await k.grants.revoke('agency-x', 'acc_a');
    await k.clock.advance('P1D');
    const lost = await buyer.reporting.poll({ now: k.clock.now() });
    assert.ok(types(lost).includes('account.unauthorized'), types(lost).join());
    const unauthorized = lost.events.find(event => event.type === 'account.unauthorized');
    assert.equal(unauthorized.occurred_at, unauthorized.data.unauthorized_at);
    await lost.ack();
    await k.grants.regrant('agency-x', 'acc_a');
    await k.clock.advance('P1D');
    const back = await buyer.reporting.poll({ now: k.clock.now() });
    const regranted = back.events.find(event => event.type === 'account.regranted');
    assert.ok(regranted, types(back).join());
    assert.equal(regranted.data.account_id, 'acc_a');
    assert.equal(regranted.data.chain, 'continued', 'a re-grant inside retention continues the chain');
  });

  test('a durable store carries the acknowledgement across clients (serverless)', async () => {
    const k = kit();
    const buyer = k.buyer('agency-x');
    await buyer.reporting.subscribe(analyticsDaily);
    await k.clock.advance('P2D');
    const store = createReportingEventStore({ store: new InMemoryStateStore() });
    const invocation = () => new ReportingClient(buyer, { eventStore: store });
    const first = await invocation().poll({ now: k.clock.now() });
    assert.ok(first.events.length > 0);
    await first.ack();
    const second = await invocation().poll({ now: k.clock.now() });
    assert.deepEqual(second.events, [], 'a fresh client resumes from the saved snapshot');
    assert.equal(memoryStorage().events.durability, 'process-local');
    assert.equal(new InMemoryReportingEventStore().durability, 'process-local');
  });
});

describe('client.reporting.handleWebhook and events', () => {
  test('only a verified delivery is accepted; with no loop running it polls inline', async () => {
    const k = kit();
    const buyer = k.buyer('agency-x');
    await buyer.reporting.subscribe(analyticsDaily);
    await assert.rejects(buyer.reporting.handleWebhook({ payload: {} }), {
      code: 'INVALID_REQUEST',
      dispatched: false,
    });
    assert.throws(() => VerifiedWebhook.fromOutcome({ ok: false, reason: 'bad_signature' }, {}), TypeError);
    assert.throws(() => VerifiedWebhook.fromOutcome({ status: 'rejected' }, {}), TypeError);
    const verified = VerifiedWebhook.fromOutcome(
      { status: 'verified', keyid: 'k1', agent_url: 'https://seller.example', verified_at: 0 },
      { notification_type: 'principal.changed' }
    );
    assert.equal(verified.senderIdentity, 'https://seller.example');
    assert.equal(VerifiedWebhook.is(verified), true);
    assert.equal(VerifiedWebhook.is({ ...verified }), false, 'a copy is not a verified delivery');
    const batch = await buyer.reporting.handleWebhook(verified);
    assert.ok(batch && batch.events.some(event => event.type === 'subscription.state_changed'));
  });

  test('the events() loop delivers, acks after the body, and wakes on the doorbell', async () => {
    const k = kit();
    const buyer = k.buyer('agency-x');
    await buyer.reporting.subscribe(analyticsDaily);
    const controller = new AbortController();
    const seen = [];
    const loop = (async () => {
      for await (const event of buyer.reporting.events({ pollEvery: 'PT1H', signal: controller.signal })) {
        seen.push(event.type);
      }
    })();
    const until = async predicate => {
      for (let i = 0; i < 200 && !predicate(); i += 1) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(predicate());
    };
    await until(() => seen.includes('subscription.state_changed'));
    const ring = await buyer.reporting.handleWebhook(
      VerifiedWebhook.fromOutcome({ ok: true, verifiedAt: 0 }, { notification_type: 'principal.changed' })
    );
    assert.equal(ring, null, 'with a loop running the doorbell wakes it instead of polling inline');
    await buyer.reporting.unsubscribe('analytics-daily');
    await buyer.reporting.handleWebhook(VerifiedWebhook.fromOutcome({ ok: true, verifiedAt: 0 }, {}));
    await until(() => seen.filter(type => type === 'subscription.state_changed').length >= 2);
    controller.abort();
    await loop;
  });
});

describe('deriveEvents', () => {
  test('ids match the Python SDK for the same natural key and version', () => {
    const current = {
      snapshot_version: 1,
      periods: {},
      subscriptions: { 'analytics-daily': { state: 'active', subscription_version: 1, pending_action: null } },
      covered: ['["analytics-daily", "acc_a"]'],
      unauthorized: {},
      authorizations: {},
      exceptions: {},
      cutovers: {},
    };
    const events = deriveEvents(null, current, { agentId: 'reference-seller', observedAt: Date.parse(day(1)) });
    // Pinned from adcp-client-python's _event_id over the same inputs.
    assert.deepEqual(
      events.map(event => [event.type, event.id]),
      [
        ['subscription.state_changed', 'rse_2434b1bd4177772b205184ad5c22f14682909900'],
        ['account.covered', 'rse_a0c00d32acedffb380ca917e91c4f962fb7bae16'],
      ]
    );
    assert.deepEqual(current.covered_generations, { '["analytics-daily", "acc_a"]': 1 });
    // A rejoin is a new occurrence, with a new id.
    const left = { ...structuredClone(current), covered: [] };
    const rejoined = deriveEvents(left, structuredClone(current), {
      agentId: 'reference-seller',
      observedAt: Date.parse(day(2)),
    });
    assert.equal(rejoined.length, 1);
    assert.notEqual(rejoined[0].id, events[1].id);
  });

  test('exceptions open and close, and a missing obligation occurs at period end plus grace', () => {
    const exception = {
      subscription_id: 's',
      account_id: 'a',
      reason: 'capacity',
      media_buy_id: 'mb',
      from: '2026-11-02T00:00:00Z',
      until: null,
      package_ids: [],
    };
    const base = {
      snapshot_version: 1,
      subscriptions: {},
      covered: [],
      unauthorized: {},
      authorizations: {},
      cutovers: {},
    };
    const opened = deriveEvents(
      { ...base, periods: {}, exceptions: {} },
      {
        ...base,
        exceptions: { k: exception },
        periods: {
          p: {
            status: 'missing_obligation',
            period: { start: '2026-11-01T00:00:00Z', end: '2026-11-02T00:00:00Z', timezone: 'UTC' },
            account_id: 'a',
          },
        },
      },
      { agentId: 'x', observedAt: Date.parse('2026-11-03T00:00:00Z') }
    );
    assert.deepEqual(
      opened.map(event => [event.type, event.occurred_at]),
      [
        ['coverage.exception_opened', '2026-11-02T00:00:00Z'],
        ['period.missing_obligation', '2026-11-02T01:00:00Z'],
      ]
    );
    const closed = deriveEvents(
      { ...base, periods: {}, exceptions: { k: exception } },
      { ...base, periods: {}, exceptions: { k: { ...exception, until: '2026-11-04T00:00:00Z' } } },
      { agentId: 'x', observedAt: Date.parse('2026-11-05T00:00:00Z') }
    );
    assert.deepEqual(
      closed.map(event => [event.type, event.occurred_at]),
      [['coverage.exception_closed', '2026-11-04T00:00:00Z']]
    );
  });
});
