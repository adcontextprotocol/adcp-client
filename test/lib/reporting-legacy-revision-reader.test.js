const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { createReportingDeliveryHandler, ReportingRowStoreError } = require('../../dist/lib/reporting/ledger/index.js');
const { AdcpError } = require('../../dist/lib/server/decisioning/async-outcome.js');

const SDK_REVISION_ID = 'rrev_sdk_owned';
const LEGACY_REVISION_ID = 'rrev_legacy_only';

/** The three store reads the exact-revision handler performs, over one SDK-owned revision. */
function sdkStore({ readRevisionRows } = {}) {
  const revision = {
    reporting_revision_id: SDK_REVISION_ID,
    reporting_obligation_id: 'robl_1',
    revisionNumber: 1,
    finality: 'snapshot',
    binding: { rowCount: 1, sha256: 'a'.repeat(64) },
    wireRevision: { revision_content_sha256: 'a'.repeat(64), control_totals: [] },
  };
  const obligation = {
    reporting_obligation_id: 'robl_1',
    account: { account_id: 'account-a' },
    period: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' },
    sourceSettings: { currency: 'USD' },
  };
  return {
    getRevisionMetadata: async (id, accountId) =>
      id === SDK_REVISION_ID && accountId === 'account-a' ? revision : null,
    getObligation: async id => (id === 'robl_1' ? obligation : null),
    readRevisionRows: readRevisionRows ?? (async () => ({ rows: [{ impressions: 7 }], total: 1 })),
  };
}

const legacyResponse = {
  reporting_period: { start: '2025-12-01T00:00:00Z', end: '2025-12-02T00:00:00Z' },
  media_buy_deliveries: [],
  reporting_rows: [{ impressions: 99, source: 'legacy' }],
};

/** A legacy reader that, as documented, scopes by the resolved account. */
function legacyReader() {
  const calls = [];
  const reader = async (request, context) => {
    calls.push({ request, context });
    const accountId = context.account.account_id;
    if (accountId === 'account-a' && request.reporting_revision_id === LEGACY_REVISION_ID) return legacyResponse;
    return null;
  };
  reader.calls = calls;
  return reader;
}

const isNotFound = error => {
  assert.ok(error instanceof AdcpError);
  assert.equal(error.code, 'REFERENCE_NOT_FOUND');
  assert.equal(error.field, 'reporting_revision_id');
  assert.equal(error.message, 'Reporting revision is unavailable');
  return true;
};
const isUnavailable = error => error instanceof AdcpError && error.code === 'SERVICE_UNAVAILABLE';
const contextA = { account: { account_id: 'account-a' } };
const read = (handler, reporting_revision_id, context = contextA) =>
  handler({ account: { account_id: context.account.account_id }, reporting_revision_id }, context);

describe('createReportingDeliveryHandler legacyRevisionReader', () => {
  test('serves an SDK-owned revision from the SDK without consulting legacy', async () => {
    const reader = legacyReader();
    const handler = createReportingDeliveryHandler(sdkStore(), { legacyRevisionReader: reader });
    const result = await read(handler, SDK_REVISION_ID);
    assert.equal(result.reporting_revision_binding.reporting_revision_id, SDK_REVISION_ID);
    assert.deepEqual(result.reporting_rows, [{ impressions: 7 }]);
    assert.equal(reader.calls.length, 0);
  });

  test('an unknown revision falls through to legacy with the same request and context', async () => {
    const reader = legacyReader();
    const handler = createReportingDeliveryHandler(sdkStore(), { legacyRevisionReader: reader });
    const request = {
      account: { account_id: 'account-a' },
      reporting_revision_id: LEGACY_REVISION_ID,
      pagination: { max_results: 5 },
    };
    const result = await handler(request, contextA);
    assert.equal(result, legacyResponse);
    assert.equal(reader.calls.length, 1);
    assert.equal(reader.calls[0].request, request);
    assert.equal(reader.calls[0].context, contextA);
  });

  test('legacy null or undefined yields the SDK nondisclosing REFERENCE_NOT_FOUND', async () => {
    for (const value of [null, undefined]) {
      const handler = createReportingDeliveryHandler(sdkStore(), { legacyRevisionReader: async () => value });
      await assert.rejects(() => read(handler, 'rrev_nowhere'), isNotFound);
    }
  });

  test('without a legacy reader an unknown revision is still REFERENCE_NOT_FOUND', async () => {
    await assert.rejects(() => read(createReportingDeliveryHandler(sdkStore()), 'rrev_nowhere'), isNotFound);
    await assert.rejects(() => read(createReportingDeliveryHandler(sdkStore(), {}), 'rrev_nowhere'), isNotFound);
  });

  test("another account's SDK revision goes to legacy, which scopes by account", async () => {
    const reader = legacyReader();
    const handler = createReportingDeliveryHandler(sdkStore(), { legacyRevisionReader: reader });
    const contextB = { account: { account_id: 'account-b' } };
    await assert.rejects(() => read(handler, SDK_REVISION_ID, contextB), isNotFound);
    assert.equal(reader.calls.length, 1);
    assert.equal(reader.calls[0].context.account.account_id, 'account-b');
    // A legacy-only revision belonging to account-a is invisible to account-b.
    await assert.rejects(() => read(handler, LEGACY_REVISION_ID, contextB), isNotFound);
  });

  test('SDK integrity and availability failures never fall through', async () => {
    for (const code of ['ROWS_INTEGRITY_FAILED', 'ROWS_UNAVAILABLE']) {
      const reader = legacyReader();
      const handler = createReportingDeliveryHandler(
        sdkStore({
          readRevisionRows: async () => {
            throw new ReportingRowStoreError(code, 'fixture');
          },
        }),
        { legacyRevisionReader: reader }
      );
      await assert.rejects(() => read(handler, SDK_REVISION_ID), isUnavailable);
      assert.equal(reader.calls.length, 0, code);
    }
    // A row count that disagrees with the committed binding is an integrity failure.
    const reader = legacyReader();
    const mismatched = createReportingDeliveryHandler(
      sdkStore({ readRevisionRows: async () => ({ rows: [{}, {}], total: 2 }) }),
      { legacyRevisionReader: reader }
    );
    await assert.rejects(() => read(mismatched, SDK_REVISION_ID), isUnavailable);
    assert.equal(reader.calls.length, 0);
  });

  test('expired rows, an unusable cursor and a vanished revision stay SDK-owned not-found', async () => {
    const reader = legacyReader();
    const expired = createReportingDeliveryHandler(
      sdkStore({
        readRevisionRows: async () => {
          throw new ReportingRowStoreError('ROWS_EXPIRED', 'fixture');
        },
      }),
      { legacyRevisionReader: reader }
    );
    await assert.rejects(() => read(expired, SDK_REVISION_ID), isNotFound);
    const vanished = createReportingDeliveryHandler(sdkStore({ readRevisionRows: async () => null }), {
      legacyRevisionReader: reader,
    });
    await assert.rejects(() => read(vanished, SDK_REVISION_ID), isNotFound);
    const cursor = createReportingDeliveryHandler(sdkStore(), { legacyRevisionReader: reader });
    await assert.rejects(
      () =>
        cursor(
          {
            account: { account_id: 'account-a' },
            reporting_revision_id: SDK_REVISION_ID,
            pagination: { cursor: 'invalid-cursor' },
          },
          contextA
        ),
      isNotFound
    );
    assert.equal(reader.calls.length, 0);
  });

  test('SDK read slots are released before the legacy reader runs', async () => {
    let release;
    const gate = new Promise(resolve => (release = resolve));
    let legacyCalls = 0;
    const handler = createReportingDeliveryHandler(sdkStore(), {
      legacyRevisionReader: async () => {
        legacyCalls += 1;
        await gate;
        return legacyResponse;
      },
    });
    // 40 legacy reads held open for one account would exhaust the 16
    // per-account SDK read slots if the slots were held across the legacy call.
    const inflight = [];
    for (let index = 0; index < 40; index += 1) {
      inflight.push(read(handler, LEGACY_REVISION_ID));
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(legacyCalls, 40);
    release();
    for (const response of await Promise.all(inflight)) assert.equal(response, legacyResponse);
  });

  test('a legacy reader error propagates unchanged', async () => {
    const boom = new Error('legacy down');
    const handler = createReportingDeliveryHandler(sdkStore(), {
      legacyRevisionReader: async () => {
        throw boom;
      },
    });
    await assert.rejects(
      () => read(handler, 'rrev_nowhere'),
      error => error === boom
    );
  });

  test('rejects a non-function legacyRevisionReader', () => {
    assert.throws(() => createReportingDeliveryHandler(sdkStore(), { legacyRevisionReader: {} }), TypeError);
  });
});
