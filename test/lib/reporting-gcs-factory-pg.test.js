const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Storage } = require('@google-cloud/storage');
const { createGcsReportingManagedDeliveryAdapterV1 } = require('../../dist/lib/reporting/gcs');
const ledger = require('../../dist/lib/reporting/ledger');
const url = process.env.REPORTING_LEDGER_PG_URL;
test(
  'GCS managed readiness fails before provider I/O when the authority migration is missing',
  { skip: !url && 'PostgreSQL URL not set' },
  async () => {
    const { Pool } = require('pg');
    const schema = `adcp_gcs_factory_${process.pid}`;
    const root = new Pool({ connectionString: url });
    await root.query(`CREATE SCHEMA "${schema}"`);
    const pool = new Pool({ connectionString: url, options: `-c search_path="${schema}"` });
    try {
      const options = {
        storage: new Storage({ projectId: 'owned-fixture-project' }),
        coreStore: new ledger.PostgresReportingLedgerStore(pool, {
          acknowledgeIsolatedDatabase: true,
          managedDelivery: true,
        }),
        store: new ledger.PostgresReportingManagedDeliveryStore(pool),
        bucket: 'owned-fixture-bucket',
        namespace: 'owned-fixture-deployment',
        acknowledgeDedicatedFreshBucket: true,
        resolveExpectedPeriod: async () => {
          throw new Error('unexpected callback');
        },
        resolveContractReader: async () => {
          throw new Error('unexpected callback');
        },
      };
      await assert.rejects(createGcsReportingManagedDeliveryAdapterV1(options), { code: 'STATE_UNAVAILABLE' });
      await assert.rejects(createGcsReportingManagedDeliveryAdapterV1({ ...options, namespace: '' }), {
        code: 'INVALID_INPUT',
      });
      await assert.rejects(createGcsReportingManagedDeliveryAdapterV1(options, { signal: AbortSignal.abort() }), {
        code: 'ABORTED',
      });
    } finally {
      await pool.end();
      await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await root.end();
    }
  }
);
