/**
 * Typed reporting-subscription errors (experimental `media_buy.reporting_subscriptions`, AdCP 3.3):
 * `ReportingSubscriptionError` (buyer), `CoverageInputError` (coverage rule),
 * `ReportingSubscriptionEngineError` and `PlatformConfigError` codes (seller engine), and the
 * `code`, `recovery` and `dispatched` fields on `PrincipalLifecycleError`.
 */
const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

process.env.NODE_ENV = 'test';

const sdk = require('@adcp/sdk');
const {
  ADCPError,
  CoverageInputError,
  PrincipalLifecycleError,
  PrincipalLifecycleTimeoutError,
  ReportingSubscriptionEngineError,
  ReportingSubscriptionError,
  RequestValidationError,
  isADCPError,
  isPreDispatchError,
  syncPrincipalLifecycle,
  syncReportingSubscriptionsV1,
} = sdk;
const { PlatformConfigError } = require('@adcp/sdk/server');
const advanced = require('@adcp/sdk/reporting/advanced');
const { InMemoryStateStore } = require('@adcp/sdk/server');
const { createTestPrincipalLifecycle } = require('../helpers/principal-runtime.js');

const SCOPE = { tenantId: 't', principalId: 'p' };
const CTX = { callerMutationScope: { tenant_id: 't', principal_id: 'p', principal_kind: 'buyer_agent' } };

// The canonical error vocabulary (adcontextprotocol/adcp#8616), vendored byte for byte.
const VOCABULARY = require('../fixtures/reporting-subscriptions/canonical/error-codes.json');
const BUYER_CODES = Object.fromEntries(
  VOCABULARY.codes
    .filter(entry => entry.sdk_classes.typescript === 'ReportingSubscriptionError')
    .map(entry => [entry.code, entry])
);

function subscription(extra = {}) {
  return {
    subscription_id: 'analytics-daily',
    subscription_version: 1,
    active: true,
    scope: { all_authorized_accounts: true },
    selector: { feed_purpose: 'analytics', period_duration: 'P1D', required_finality: 'official' },
    reconciliation_mode: 'delivery_only',
    ...extra,
  };
}

function wrap(data) {
  return {
    success: true,
    status: 'completed',
    data,
    metadata: { status: 'completed', taskName: 'principal' },
    conversation: [],
    debug_logs: [],
  };
}

function principalClient(lifecycle) {
  return {
    getPrincipal: async params => wrap(await lifecycle.protocol.getPrincipal(params ?? {}, CTX)),
    syncPrincipal: async params => wrap(await lifecycle.protocol.syncPrincipal(params, CTX)),
  };
}

function keys() {
  let key = 0;
  return { createIdempotencyKey: () => `idempotency-key-${String(++key).padStart(4, '0')}` };
}

describe('error-codes.json', () => {
  test('every code maps to the TS class it names, with its recovery and dispatched rule', () => {
    const classes = { ReportingSubscriptionError, CoverageInputError, PlatformConfigError };
    assert.equal(VOCABULARY.codes.length, 14);
    for (const entry of VOCABULARY.codes) {
      const Class = classes[entry.sdk_classes.typescript];
      assert.ok(Class, `${entry.code}: unknown TS class ${entry.sdk_classes.typescript}`);
      const error =
        Class === PlatformConfigError
          ? new PlatformConfigError('message. Fix it.', { code: entry.code })
          : new Class(entry.code, 'message. Fix it.');
      assert.equal(error.name, entry.sdk_classes.typescript, entry.code);
      assert.equal(error.code, entry.code);
      assert.equal(error.recovery, entry.recovery, entry.code);
      if (entry.dispatched === 'false') assert.equal(error.dispatched, false, entry.code);
      else assert.equal('dispatched' in error, false, entry.code);
    }
  });
});

describe('ReportingSubscriptionError', () => {
  test('carries the shared code, recovery and dispatched vocabulary', () => {
    for (const [code, expected] of Object.entries(BUYER_CODES)) {
      const error = new ReportingSubscriptionError(code, 'message. Fix it.');
      assert.ok(error instanceof ADCPError && isADCPError(error), code);
      assert.equal(error.name, 'ReportingSubscriptionError');
      assert.equal(error.code, code);
      assert.equal(error.recovery, expected.recovery, code);
      assert.equal(isPreDispatchError(error), expected.dispatched === 'false', code);
      if (expected.dispatched === 'absent') assert.equal('dispatched' in error, false, code);
    }
  });

  test('syncReportingSubscriptionsV1 refuses an omission before sending, with the subscriptions it would deactivate', async () => {
    const { lifecycle } = createTestPrincipalLifecycle({ reportingSubscriptions: {} });
    const client = principalClient(lifecycle);
    const options = keys();
    const other = subscription({ subscription_id: 'analytics-other', scope: { account_ids: ['acct_2'] } });
    await syncReportingSubscriptionsV1(client, [subscription(), other], options);
    let writes = 0;
    const counting = { ...client, syncPrincipal: async params => (writes++, client.syncPrincipal(params)) };
    await assert.rejects(syncReportingSubscriptionsV1(counting, [subscription()], options), error => {
      assert.ok(error instanceof ReportingSubscriptionError);
      assert.equal(error.code, 'SUBSCRIPTION_WOULD_DEACTIVATE');
      assert.equal(error.recovery, 'correctable');
      assert.equal(error.dispatched, false);
      assert.deepEqual(error.wouldDeactivate, ['analytics-other']);
      assert.match(error.message, /pass allowDeactivation: true\.$/);
      return true;
    });
    assert.equal(writes, 0);
  });

  test('an omission found on the re-read after a conflict is still pre-dispatch: the conflicted write applied nothing', async () => {
    const { lifecycle } = createTestPrincipalLifecycle({ reportingSubscriptions: {} });
    const client = principalClient(lifecycle);
    const options = keys();
    await syncReportingSubscriptionsV1(client, [subscription()], options);
    // A concurrent writer adds a subscription between our read and our write.
    let raced = false;
    const racing = {
      ...client,
      syncPrincipal: async params => {
        if (!raced) {
          raced = true;
          await client.syncPrincipal({
            idempotency_key: 'concurrent-writer-000001',
            configuration: {
              reporting_subscriptions: [
                subscription(),
                subscription({ subscription_id: 'concurrent', scope: { account_ids: ['acct_9'] } }),
              ],
            },
          });
        }
        return client.syncPrincipal(params);
      },
    };
    await assert.rejects(
      syncReportingSubscriptionsV1(
        racing,
        [subscription({ subscription_version: 2, exclude_account_ids: ['z'] })],
        options
      ),
      error => {
        assert.equal(error.code, 'SUBSCRIPTION_WOULD_DEACTIVATE');
        assert.deepEqual(error.wouldDeactivate, ['concurrent']);
        assert.equal(error.dispatched, false, 'the refused write was never sent');
        return true;
      }
    );
  });

  test('conflict exhaustion and a changed readback have their own codes', async () => {
    const { lifecycle } = createTestPrincipalLifecycle({ reportingSubscriptions: {} });
    const client = principalClient(lifecycle);
    // A conflict retry needs the identity fence of a configured principal.
    await syncReportingSubscriptionsV1(client, [subscription()], keys());
    const conflicting = {
      ...client,
      syncPrincipal: async () =>
        wrap({ result: { kind: 'failed', errors: [{ code: 'CONFLICT', message: 'stale', recovery: 'transient' }] } }),
    };
    await assert.rejects(
      syncReportingSubscriptionsV1(conflicting, [subscription()], { ...keys(), maxAttempts: 2 }),
      error => {
        assert.equal(error.code, 'SUBSCRIPTION_CONFLICT_EXHAUSTED');
        assert.equal(error.recovery, 'transient');
        assert.equal('dispatched' in error, false);
        assert.ok(error.cause instanceof PrincipalLifecycleError);
        assert.equal(error.cause.code, 'PRINCIPAL_CONFLICT_EXHAUSTED');
        assert.match(error.message, /retry later\.$/);
        return true;
      }
    );
    const rewriting = {
      ...client,
      syncPrincipal: async params => {
        const response = await client.syncPrincipal(params);
        for (const state of response.data.result.configuration.reporting_subscriptions ?? []) {
          state.configuration = { ...state.configuration, exclude_account_ids: ['seller-chosen'] };
        }
        return response;
      },
    };
    await assert.rejects(
      syncReportingSubscriptionsV1(
        rewriting,
        [subscription({ subscription_version: 2, exclude_account_ids: ['z'] })],
        keys()
      ),
      error => {
        assert.equal(error.code, 'SUBSCRIPTION_READBACK_MISMATCH');
        assert.equal(error.recovery, 'terminal');
        assert.equal(error.readback.subscription_id, 'analytics-daily');
        assert.equal(error.appliedResponse.kind, 'applied');
        assert.match(error.message, /contact the seller\.$/);
        return true;
      }
    );
  });
});

describe('PrincipalLifecycleError', () => {
  test('is an ADCPError with code and recovery; applied is a deprecated alias of appliedResponse', () => {
    const applied = { kind: 'applied', principal_id: 'p', principal_kind: 'buyer_agent' };
    const error = new PrincipalLifecycleError('boom', { applied });
    assert.ok(isADCPError(error));
    assert.equal(error.code, 'PRINCIPAL_LIFECYCLE_FAILED');
    assert.equal(error.recovery, 'terminal');
    assert.equal(error.appliedResponse, applied);
    assert.equal(error.applied, applied);
    assert.equal('dispatched' in error, false);
    const timeout = new PrincipalLifecycleTimeoutError(undefined, { appliedResponse: applied });
    assert.equal(timeout.code, 'PRINCIPAL_SETUP_TIMEOUT');
    assert.equal(timeout.recovery, 'transient');
    assert.equal(timeout.applied, applied);
    const fromWire = new PrincipalLifecycleError('failed', {
      code: 'PRINCIPAL_WRITE_FAILED',
      protocolErrors: [{ code: 'INVALID_REQUEST', recovery: 'correctable' }],
    });
    assert.equal(fromWire.recovery, 'correctable', "the seller's recovery wins");
  });

  test('a principal-kind refusal on the first read is pre-dispatch', async () => {
    const { lifecycle } = createTestPrincipalLifecycle({ reportingSubscriptions: {} });
    const client = principalClient(lifecycle);
    await syncPrincipalLifecycle(client, { reporting_subscriptions: [subscription()] }, keys());
    await assert.rejects(
      syncPrincipalLifecycle(
        client,
        { reporting_subscriptions: [subscription()] },
        {
          ...keys(),
          expectedPrincipalKind: 'governance_agent',
        }
      ),
      error => {
        assert.equal(error.code, 'PRINCIPAL_IDENTITY_CHANGED');
        assert.equal(error.dispatched, false);
        assert.ok(isPreDispatchError(error));
        return true;
      }
    );
  });

  test('a write the client refused locally is pre-dispatch; a transport failure is not', async () => {
    const { lifecycle } = createTestPrincipalLifecycle({ reportingSubscriptions: {} });
    const client = principalClient(lifecycle);
    const refusing = {
      ...client,
      syncPrincipal: async () => {
        throw new RequestValidationError('sync_principal', ['/configuration'], 'invalid');
      },
    };
    await assert.rejects(syncPrincipalLifecycle(refusing, { reporting_subscriptions: [] }, keys()), error => {
      assert.equal(error.code, 'PRINCIPAL_TRANSPORT_FAILED');
      assert.equal(error.dispatched, false);
      assert.equal(error.recovery, 'correctable');
      return true;
    });
    const broken = {
      ...client,
      syncPrincipal: async () => {
        throw new Error('socket hang up');
      },
    };
    await assert.rejects(syncPrincipalLifecycle(broken, { reporting_subscriptions: [] }, keys()), error => {
      assert.equal(error.code, 'PRINCIPAL_TRANSPORT_FAILED');
      assert.equal('dispatched' in error, false);
      assert.equal(error.recovery, 'transient');
      assert.ok(error.attemptedRequest);
      return true;
    });
  });
});

describe('coverage and engine errors', () => {
  test('the coverage function throws CoverageInputError from the advanced subpath and the root', () => {
    assert.equal(advanced.CoverageInputError, CoverageInputError);
    assert.equal(advanced.ReportingSubscriptionEngineError, ReportingSubscriptionEngineError);
    assert.throws(() => advanced.parseReportingPeriodDurationV1('P1W'), {
      name: 'CoverageInputError',
      code: 'COVERAGE_INPUT_INVALID',
      detail: 'invalid_period_duration',
      recovery: 'correctable',
    });
  });

  test('engine configuration mistakes are PlatformConfigError with a code and the option', () => {
    const { lifecycle } = createTestPrincipalLifecycle({ reportingSubscriptions: {} });
    const hooks = {
      listAuthorizedAccounts: () => ({ accounts: [] }),
      listAccountBuys: () => [],
      resolveRevocationInstant: (_p, _a, input) => input.observedAt,
      isPeriodDelivered: () => false,
    };
    assert.throws(
      () =>
        advanced.createReportingSubscriptionEngineV1({
          principal: lifecycle,
          offerings: [],
          hooks,
          statusRetentionDays: 0,
        }),
      error =>
        error instanceof PlatformConfigError &&
        error.code === 'PLATFORM_CONFIG_INVALID' &&
        error.configField === 'statusRetentionDays' &&
        error.recovery === 'correctable'
    );
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.throws(
        () =>
          advanced.createReportingSubscriptionEngineV1({
            principal: lifecycle,
            offerings: [],
            hooks,
            statusRetentionDays: 30,
          }),
        { name: 'PlatformConfigError', code: 'REPORTING_STORAGE_NOT_DURABLE', configField: 'store' }
      );
    } finally {
      process.env.NODE_ENV = previous;
    }
    assert.throws(
      () =>
        advanced.createReportingSubscriptionEngineStateStoreV1({
          store: new InMemoryStateStore(),
          durability: 'durable',
        }),
      { name: 'PlatformConfigError', code: 'REPORTING_STORAGE_NOT_DURABLE' }
    );
  });

  test('runtime engine failures are ReportingSubscriptionEngineError', async () => {
    const { lifecycle } = createTestPrincipalLifecycle({ reportingSubscriptions: {} });
    await syncReportingSubscriptionsV1(principalClient(lifecycle), [subscription()], keys());
    const base = {
      principal: lifecycle,
      offerings: [],
      statusRetentionDays: 30,
      hooks: {
        listAuthorizedAccounts: () => ({ accounts: [], nextCursor: 'same' }),
        listAccountBuys: () => [],
        resolveRevocationInstant: (_p, _a, input) => input.observedAt,
        isPeriodDelivered: () => false,
      },
    };
    const looping = advanced.createReportingSubscriptionEngineV1({
      ...base,
      hooks: {
        ...base.hooks,
        listAuthorizedAccounts: ({}, { cursor }) => ({ accounts: [], nextCursor: cursor ?? 'same' }),
      },
    });
    await assert.rejects(looping.reconcile(SCOPE), {
      name: 'ReportingSubscriptionEngineError',
      code: 'SUBSCRIPTION_ROSTER_INCOMPLETE',
      recovery: 'correctable',
    });
    const store = advanced.createInMemoryReportingSubscriptionEngineStoreV1();
    const contended = advanced.createReportingSubscriptionEngineV1({
      ...base,
      hooks: { ...base.hooks, listAuthorizedAccounts: () => ({ accounts: [] }) },
      maxCasAttempts: 2,
      store: { ...store, put: async () => ({ outcome: 'conflict' }) },
    });
    await assert.rejects(contended.reconcile(SCOPE), {
      name: 'ReportingSubscriptionEngineError',
      code: 'SUBSCRIPTION_STATE_CONFLICT',
      recovery: 'transient',
    });
  });
});
