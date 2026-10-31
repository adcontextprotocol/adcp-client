/**
 * The buyer write facade, client.reporting (experimental `media_buy.reporting_subscriptions`, AdCP
 * 3.3): patch-shaped subscribe/unsubscribe over the replace-shaped sync_principal wire,
 * auto-versioning, pre-dispatch checks, and the raw syncPrincipal guard.
 */
const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

process.env.NODE_ENV = 'test';

const { ReportingClient, guardSyncPrincipal } = require('@adcp/sdk');
const { createTestPrincipalLifecycle } = require('../helpers/principal-runtime.js');

const CTX = { callerMutationScope: { tenant_id: 't', principal_id: 'p', principal_kind: 'buyer_agent' } };

function subscription(extra = {}) {
  return {
    subscription_id: 'analytics-daily',
    scope: { all_authorized_accounts: true },
    selector: {
      feed_purpose: 'analytics',
      period_duration: 'P1D',
      required_finality: 'official',
      dimensions: ['package'],
    },
    reconciliation_mode: 'delivery_only',
    ...extra,
  };
}

const wrap = data => ({ success: true, status: 'completed', data, metadata: {}, conversation: [], debug_logs: [] });

function client(extra = {}) {
  const { lifecycle } = createTestPrincipalLifecycle({ reportingSubscriptions: {} });
  const writes = [];
  return {
    lifecycle,
    writes,
    getPrincipal: async params => wrap(await lifecycle.protocol.getPrincipal(params ?? {}, CTX)),
    syncPrincipal: async params => {
      writes.push(params);
      return wrap(await lifecycle.protocol.syncPrincipal(params, CTX));
    },
    ...extra,
  };
}

describe('client.reporting', () => {
  test('subscribe auto-versions, keeps other entries, and unsubscribe is the deactivation path', async () => {
    const c = client();
    const reporting = new ReportingClient(c);
    const created = await reporting.subscribe(subscription());
    assert.equal(created.action, 'created');
    assert.equal(created.subscriptionVersion, 1);
    assert.equal(created.state.state, 'active');
    const other = await reporting.subscribe(subscription({ subscription_id: 'pacing', scope: { account_ids: ['a'] } }));
    assert.equal(other.action, 'created');
    const writes = c.writes.length;
    assert.equal((await reporting.subscribe(subscription())).action, 'unchanged');
    assert.equal(c.writes.length, writes, 'an unchanged subscription is not written');
    // adcp#8619: a membership edit applies in place, under the same version.
    const membership = await reporting.subscribe(subscription({ exclude_account_ids: ['z'] }));
    assert.equal(membership.action, 'updated');
    assert.equal(membership.subscriptionVersion, 1, 'membership changes in place');
    const changedSelector = { ...subscription().selector, required_finality: 'snapshot' };
    const updated = await reporting.subscribe(subscription({ exclude_account_ids: ['z'], selector: changedSelector }));
    assert.equal(updated.action, 'updated');
    assert.equal(updated.subscriptionVersion, 2, 'a semantic change bumps the version');
    const all = await reporting.listSubscriptions();
    assert.deepEqual(all.subscriptions.map(item => item.subscription_id).sort(), ['analytics-daily', 'pacing']);
    assert.equal(all.subscriptions.find(item => item.subscription_id === 'pacing').subscription_version, 1);
    const gone = await reporting.unsubscribe('analytics-daily');
    assert.equal(gone.action, 'deactivated');
    assert.equal(gone.state.state, 'inactive');
    assert.equal(gone.subscriptionVersion, 2, 'active changes in place');
    const back = await reporting.subscribe(subscription({ exclude_account_ids: ['z'], selector: changedSelector }));
    assert.equal(back.action, 'reactivated');
  });

  test('malformed calls are refused before anything is sent', async () => {
    const c = client();
    const reporting = new ReportingClient(c);
    await reporting.subscribe(subscription());
    const before = c.writes.length;
    for (const [call, pattern] of [
      [() => reporting.subscribe(subscription({ scope: {} })), /scope must be explicit/],
      [
        () =>
          reporting.subscribe(
            subscription({
              subscription_version: 1,
              selector: { ...subscription().selector, required_finality: 'snapshot' },
            })
          ),
        /must exceed 1/,
      ],
      [() => reporting.subscribe(subscription({ destination: { destination_id: 'missing' } })), /not registered/],
      [() => reporting.unsubscribe('nope'), /No subscription "nope"/],
      [() => reporting.replaceSubscriptions([]), /deactivateAll: true/],
    ]) {
      await assert.rejects(call(), error => {
        assert.equal(error.name, 'ReportingSubscriptionError');
        assert.equal(error.code, 'INVALID_REQUEST');
        assert.equal(error.dispatched, false);
        assert.match(error.message, pattern);
        return true;
      });
    }
    await assert.rejects(
      reporting.replaceSubscriptions([
        { ...subscription({ subscription_id: 'x' }), subscription_version: 1, active: true },
      ]),
      {
        code: 'SUBSCRIPTION_WOULD_DEACTIVATE',
        dispatched: false,
      }
    );
    assert.equal(c.writes.length, before);
  });

  test('a subscription_id clash and an unmatched selector are refused from the seller roster and capabilities', async () => {
    const offering = {
      offering_id: 'off_daily',
      feed_purpose: 'analytics',
      schedule: { period_duration: 'P1D', alignment: 'utc' },
      supported_finality: ['official'],
      reconciliation_mode: 'delivery_only',
      standard_dimensions: ['package'],
    };
    const c = client({
      listAccounts: async () =>
        wrap({
          accounts: [{ account_id: 'acc_1', reporting_delivery_configs: [{ delivery_config_id: 'analytics-daily' }] }],
        }),
      getAdcpCapabilities: async () => wrap({ media_buy: { reporting_delivery: { offerings: [offering] } } }),
    });
    const reporting = new ReportingClient(c);
    await assert.rejects(reporting.subscribe(subscription()), {
      code: 'SUBSCRIPTION_ID_CLASH',
      deliveryConfigId: 'analytics-daily',
      accountId: 'acc_1',
      dispatched: false,
    });
    await assert.rejects(
      reporting.subscribe(
        subscription({ subscription_id: 'hourly', selector: { ...subscription().selector, period_duration: 'PT1H' } })
      ),
      error => {
        assert.equal(error.code, 'SUBSCRIPTION_SELECTOR_UNMATCHED');
        assert.deepEqual(error.nearest, [{ offering_id: 'off_daily', failed: ['period_duration'] }]);
        return true;
      }
    );
    const preview = await reporting.preview(subscription({ subscription_id: 'daily' }));
    assert.equal(preview.wouldBe, 'created');
    assert.deepEqual(preview.offeringIds, ['off_daily']);
    assert.equal((await reporting.listSubscriptions()).subscriptions.length, 0, 'a preview is a dry run');
  });

  test('a seller that alters a submitted field fails the readback check', async () => {
    const c = client();
    const rewriting = {
      ...c,
      syncPrincipal: async params => {
        const response = await c.syncPrincipal(params);
        for (const state of response.data.result.configuration.reporting_subscriptions ?? []) {
          state.configuration = { ...state.configuration, exclude_account_ids: ['seller-chosen'] };
        }
        return response;
      },
    };
    await assert.rejects(
      new ReportingClient(rewriting).subscribe(subscription({ exclude_account_ids: ['z'] })),
      error => {
        assert.equal(error.code, 'SUBSCRIPTION_READBACK_MISMATCH');
        assert.equal(error.recovery, 'terminal');
        assert.equal('dispatched' in error, false);
        assert.equal(error.readback.subscription_id, 'analytics-daily');
        assert.match(error.message, /stores a different configuration at \/exclude_account_ids\/0/);
        return true;
      }
    );
    const dropping = {
      ...c,
      syncPrincipal: async params => {
        const response = await c.syncPrincipal(params);
        response.data.result.configuration.reporting_subscriptions = [];
        return response;
      },
    };
    await assert.rejects(
      new ReportingClient(dropping).subscribe(
        subscription({ subscription_id: 'other', scope: { account_ids: ['a'] } })
      ),
      {
        code: 'SUBSCRIPTION_READBACK_MISMATCH',
        message: /does not carry version 1/,
      }
    );
  });

  test('CONFLICT on every attempt exhausts the retries', async () => {
    const c = client();
    await new ReportingClient(c).subscribe(subscription());
    const conflicting = {
      ...c,
      syncPrincipal: async () => wrap({ result: { kind: 'failed', errors: [{ code: 'CONFLICT', message: 'stale' }] } }),
    };
    await assert.rejects(
      new ReportingClient(conflicting, { maxAttempts: 2 }).subscribe(subscription({ exclude_account_ids: ['z'] })),
      {
        code: 'SUBSCRIPTION_CONFLICT_EXHAUSTED',
        recovery: 'transient',
      }
    );
  });
});

describe('the raw syncPrincipal guard', () => {
  test('refuses a write that deactivates by omission unless allowed; dry runs pass', async () => {
    const c = client();
    await new ReportingClient(c).subscribe(subscription());
    const omit = { configuration: { reporting_subscriptions: [] } };
    await assert.rejects(guardSyncPrincipal(c, omit), {
      code: 'SUBSCRIPTION_WOULD_DEACTIVATE',
      dispatched: false,
      wouldDeactivate: ['analytics-daily'],
    });
    await guardSyncPrincipal(c, omit, { allowDeactivation: true });
    await guardSyncPrincipal(c, { ...omit, dry_run: true });
    // A write that doesn't submit the section reads nothing.
    let reads = 0;
    await guardSyncPrincipal(
      { getPrincipal: async () => (reads++, c.getPrincipal()) },
      { configuration: { notification_configs: [] } }
    );
    assert.equal(reads, 0);
  });
});
