/**
 * `pagination.max_results` on the reporting handlers is AdCP's: an integer from 1 to 100, 50 when absent. The bounds
 * come from `core/pagination-request.json`, and anything else is a VALIDATION_ERROR, so the same request behaves the
 * same on every seller.
 */
const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createReportingDeliveryHandler,
  createReportingStatusHandler,
} = require('../../dist/lib/reporting/ledger/index.js');
const { AdcpError } = require('../../dist/lib/server/decisioning/async-outcome.js');
const { getSchemaDocumentByRef } = require('../../dist/lib/validation/schema-loader.js');
const { MemoryLedgerStore } = require('../helpers/memory-reporting-ledger-store.js');

const schemaField = getSchemaDocumentByRef('core/pagination-request.json').schema.properties.max_results;
const { minimum, maximum, default: schemaDefault } = schemaField;
const REVISION_ID = 'rrev_bounds';
const context = { account: { account_id: 'account-a' } };

/** The exact-revision reads over one SDK-owned revision, recording how many rows each page asked for. */
function deliveryStore() {
  const seen = { revisionReads: 0, limits: [] };
  const revision = {
    reporting_revision_id: REVISION_ID,
    reporting_obligation_id: 'robl_bounds',
    revisionNumber: 1,
    finality: 'snapshot',
    binding: { rowCount: 1_000, sha256: 'a'.repeat(64) },
    wireRevision: { revision_content_sha256: 'a'.repeat(64), control_totals: [] },
  };
  const obligation = {
    reporting_obligation_id: 'robl_bounds',
    account: { account_id: 'account-a' },
    period: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' },
    sourceSettings: { currency: 'USD' },
  };
  return {
    seen,
    getRevisionMetadata: async id => {
      seen.revisionReads += 1;
      return id === REVISION_ID ? revision : null;
    },
    getObligation: async () => obligation,
    readRevisionRows: async input => {
      seen.limits.push(input.limit);
      return { rows: [], total: 1_000 };
    },
  };
}

const isValidation = field => error => {
  assert.ok(error instanceof AdcpError, String(error));
  assert.equal(error.code, 'VALIDATION_ERROR');
  assert.equal(error.field, field);
  assert.match(error.message, new RegExp(`${minimum} to ${maximum}`));
  return true;
};
const invalid = [0, -1, maximum + 1, 500, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5', null, true, {}, []];

describe('the schema defines the bounds', () => {
  test('1 to 100, defaulting to 50', () => {
    assert.deepEqual([minimum, maximum, schemaDefault], [1, 100, 50]);
  });
});

describe('get_media_buy_delivery exact revision reads', () => {
  test('default to the schema default and accept the schema bounds', async () => {
    const store = deliveryStore();
    const handler = createReportingDeliveryHandler(store);
    const read = pagination =>
      handler({ account: { account_id: 'account-a' }, reporting_revision_id: REVISION_ID, pagination }, context);
    await read(undefined);
    await read({});
    await read({ cursor: undefined });
    await read({ max_results: minimum });
    await read({ max_results: maximum });
    assert.deepEqual(store.seen.limits, [schemaDefault, schemaDefault, schemaDefault, minimum, maximum]);
  });

  test('refuse a value outside the schema with VALIDATION_ERROR before reading anything', async () => {
    const store = deliveryStore();
    const handler = createReportingDeliveryHandler(store);
    for (const max_results of invalid) {
      await assert.rejects(
        () =>
          handler(
            { account: { account_id: 'account-a' }, reporting_revision_id: REVISION_ID, pagination: { max_results } },
            context
          ),
        isValidation('pagination.max_results'),
        String(max_results)
      );
    }
    assert.equal(store.seen.revisionReads, 0, 'nothing was read for a request the schema refuses');
  });

  test('refuse it even for a revision this ledger does not own, so a legacy reader never sees it', async () => {
    const reader = async () => {
      throw new Error('the legacy reader must not run');
    };
    const handler = createReportingDeliveryHandler(deliveryStore(), { legacyRevisionReader: reader });
    await assert.rejects(
      () =>
        handler(
          {
            account: { account_id: 'account-a' },
            reporting_revision_id: 'rrev_elsewhere',
            pagination: { max_results: 500 },
          },
          context
        ),
      isValidation('pagination.max_results')
    );
  });
});

describe('get_reporting_status paged views', () => {
  /** A store that records the page size the handler asks for, then stops. */
  function statusStore() {
    const store = new MemoryLedgerStore();
    const limits = [];
    store.limits = limits;
    store.createSnapshot = async () => ({
      snapshotId: 'snapshot_bounds',
      obligations: [],
      revisions: [],
      adjustments: [],
    });
    store.readSnapshotPage = async (_id, _account, _cursor, limit) => {
      limits.push(limit);
      throw new Error('stop after the page size is known');
    };
    return store;
  }
  const request = pagination => ({
    account: { account_id: 'account-a' },
    view: 'periods',
    ...(pagination === undefined ? {} : { pagination }),
  });

  test('default to the schema default, accept the schema bounds, and ignore the non-AdCP limit field', async () => {
    const store = statusStore();
    const handler = createReportingStatusHandler(store);
    for (const pagination of [undefined, {}, { max_results: minimum }, { max_results: maximum }, { limit: 7 }]) {
      await assert.rejects(() => handler(request(pagination), context), /stop after the page size is known/);
    }
    assert.deepEqual(store.limits, [schemaDefault, schemaDefault, minimum, maximum, schemaDefault]);
  });

  test('refuse a value outside the schema with VALIDATION_ERROR before reading anything', async () => {
    const store = statusStore();
    const handler = createReportingStatusHandler(store);
    for (const max_results of invalid) {
      await assert.rejects(
        () => handler(request({ max_results }), context),
        isValidation('pagination.max_results'),
        String(max_results)
      );
    }
    assert.deepEqual(store.limits, []);
  });
});
