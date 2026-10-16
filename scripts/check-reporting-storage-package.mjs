#!/usr/bin/env node
/**
 * Smoke the actual npm tarballs of `@adcp/sdk` and `@adcp/reporting-storage` together, under both Node module
 * modes. The storage package imports the SDK through its public subpaths and shares classes and symbol-keyed
 * guards with it, so this proves the packed pair resolves, loads once per format, and composes: the store
 * the storage package builds is accepted by the SDK's service, and the SDK's error classes are the ones the
 * store throws.
 */
import { execFileSync } from 'node:child_process';
import { accessSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(join(tmpdir(), 'adcp-reporting-storage-pack-'));

function pack(cwd, extra = []) {
  const output = execFileSync(
    'npm',
    ['pack', '--silent', '--json', '--ignore-scripts', '--pack-destination', temporary, ...extra],
    { cwd, encoding: 'utf8' }
  );
  // The repository's npm prepare hook writes a status line before pack's JSON.
  const jsonStart = output.lastIndexOf('\n[');
  const filename = JSON.parse(jsonStart < 0 ? output : output.slice(jsonStart + 1))[0]?.filename;
  if (!filename) throw new Error('npm pack did not return a tarball');
  return join(temporary, filename);
}

function extract(tarball, destination) {
  mkdirSync(destination, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', destination, '--strip-components=1']);
}

const SUBPATHS = {
  '@adcp/reporting-storage': ['PostgresReportingLedgerStore', 'reportingLedgerMaintenance'],
  '@adcp/reporting-storage/managed': ['createReportingManagedDeliveryRuntime', 'PostgresReportingManagedDeliveryStore'],
  '@adcp/reporting-storage/notifications': ['createPostgresReportingNotificationActivityRuntime'],
  '@adcp/reporting-storage/service': ['createPostgresReliableReportingProductionService'],
  '@adcp/reporting-storage/gcs': ['createGcsReportingRowObjectProviderV1'],
  '@adcp/reporting-storage/s3': ['createS3ReportingRowObjectProviderV1'],
  '@adcp/reporting-storage/azure': ['createAzureBlobReportingRowObjectProviderV1'],
  '@adcp/reporting-storage/bigquery': ['createBigQueryReportingWarehouseSinkV1'],
};

try {
  const sdkDir = join(temporary, 'node_modules', '@adcp', 'sdk');
  const storageDir = join(temporary, 'node_modules', '@adcp', 'reporting-storage');
  extract(pack(root), sdkDir);
  extract(pack(join(root, 'packages', 'reporting-storage')), storageDir);
  // The SDK resolves its third-party dependencies from the repository's installed tree. The storage package
  // finds the SDK as its sibling (the packed one, not the workspace), and the cloud SDKs it loads for the
  // `/s3` and `/azure` subpaths from the same tree; scope by scope, so the workspace `@adcp/sdk` link in that
  // tree can never shadow the packed copy.
  symlinkSync(join(root, 'node_modules'), join(sdkDir, 'node_modules'), 'dir');
  for (const scope of ['@aws-sdk', '@azure', '@google-cloud']) {
    symlinkSync(join(root, 'node_modules', scope), join(temporary, 'node_modules', scope), 'dir');
  }

  for (const file of ['index.js', 'index.mjs', 'index.d.ts', 'index.d.mts']) {
    accessSync(join(storageDir, 'dist', file));
    for (const sub of ['managed', 'notifications', 'service', 'gcs', 's3', 'azure', 'bigquery']) {
      accessSync(join(storageDir, 'dist', sub, file));
    }
  }

  const check = `
    for (const [module, names] of Object.entries(EXPECTED)) {
      const loaded = LOADED[module];
      for (const name of names) assert.equal(typeof loaded[name], 'function', module + ' ' + name);
    }
    assert.equal(sdkLedger.PostgresReportingLedgerStore, undefined, 'the SDK no longer carries the store');
    assert.equal(typeof sdkLedger.createReportingStatusHandler, 'function');
    assert.equal(typeof service.createReliableReportingService, 'function');
    // One class per format: the store throws the SDK's own error class, so the handlers recognize it.
    const store = new storage.PostgresReportingLedgerStore(
      { query: async () => ({ rows: [], rowCount: 0 }), connect: async () => ({}) },
      { acknowledgeIsolatedDatabase: true }
    );
    assert.equal(typeof storage.REPORTING_LEDGER_MIGRATION, 'string');
    assert.deepEqual(store.migrations, [storage.REPORTING_LEDGER_MIGRATION]);
    assert.equal(typeof store.sweepRowWriteIntents, 'function');
    assert.equal(typeof managed.PostgresReportingManagedDeliveryStore, 'function');

    // The error classes the package throws are the SDK's own, in this module format.
    let thrown;
    try {
      storage.renderReportingRowObjectKeyV1({ template: '{prefix}', prefix: 'p', periodStart: 'not-a-date', sourceTimezone: 'UTC' });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof sdkLedger.ReportingRowStoreError, 'one ReportingRowStoreError class');
    assert.equal(sdkLedger.isReportingRowStoreError(thrown), true);

    // The SDK's service accepts the package's store and its maintenance factory, and surfaces the store's migrations.
    const offering = source.redactedReportingSourceOfferingV1;
    const sourceOffering = structuredClone(offering);
    sourceOffering.cadence = { ...sourceOffering.cadence, expectedAvailabilityLag: 'PT0S', worstCaseAvailabilityLag: 'PT0S' };
    const [template] = source.redactedReportingSourceRequestV1().coverage.constituents;
    const reporting = service.createReliableReportingService({
      store,
      adapters: {
        fixture: {
          sourceOffering,
          deliveryOffering: {
            offering_id: offering.offeringId,
            feed_purpose: 'analytics',
            report_definition_id: offering.contract.report_definition_id,
            report_definition_uri: offering.contract.reportDefinitionUri,
            report_definition_sha256: offering.contract.reportDefinitionSha256,
            reporting_profile: {
              id: offering.contract.reportingProfile,
              version: offering.contract.schemaVersion,
              schema_uri: offering.contract.schemaUri,
              schema_sha256: offering.contract.schemaSha256,
              schema_dialect: offering.contract.schemaDialect,
              schema_ref_policy: offering.contract.schemaRefPolicy,
              grain: offering.grain,
              primary_keys: ['media_buy_id'],
            },
            schedule: { period_duration: 'P1D', alignment: 'source_timezone', period_timezone_policy: 'fixed', period_timezone: 'UTC', delivery_sla: 'PT0S' },
            supported_finality: ['snapshot'],
            reconciliation_mode: 'delivery_only',
          },
          fetchSlice: request => ({ reporting_period: { start: request.start_date, end: request.end_date }, currency: 'USD', reporting_rows: [] }),
        },
      },
      contact: { name: 'Reporting operations', email: 'reporting@example.com' },
      automatedRecoveryWindowSeconds: 86_400,
      statusRetentionDays: offering.retentionDays,
      resolveSource: account => ({ adapterId: 'fixture', sourceScope: { network_id: 'network-' + account.id }, sourceTimezone: 'UTC' }),
      resolveCurrency: () => 'USD',
      resolveCoverage: account => ({ constituents: [{ ...structuredClone(template), constituentId: 'c-' + account.id }] }),
      maintenance: storage.reportingLedgerMaintenance({ retention: { enabled: true } }),
    });
    assert.deepEqual(reporting.setup.migrations, [storage.REPORTING_LEDGER_MIGRATION]);
    assert.equal(typeof reporting.runMaintenance, 'function');
  `;
  const expected = JSON.stringify(SUBPATHS);

  writeFileSync(
    join(temporary, 'consumer.cjs'),
    `
    const assert = require('node:assert/strict');
    const LOADED = {
      '@adcp/reporting-storage': require('@adcp/reporting-storage'),
      '@adcp/reporting-storage/managed': require('@adcp/reporting-storage/managed'),
      '@adcp/reporting-storage/notifications': require('@adcp/reporting-storage/notifications'),
      '@adcp/reporting-storage/service': require('@adcp/reporting-storage/service'),
      '@adcp/reporting-storage/gcs': require('@adcp/reporting-storage/gcs'),
      '@adcp/reporting-storage/s3': require('@adcp/reporting-storage/s3'),
      '@adcp/reporting-storage/azure': require('@adcp/reporting-storage/azure'),
      '@adcp/reporting-storage/bigquery': require('@adcp/reporting-storage/bigquery'),
    };
    const EXPECTED = ${expected};
    const sdkLedger = require('@adcp/sdk/reporting/ledger');
    const storage = require('@adcp/reporting-storage');
    const managed = require('@adcp/reporting-storage/managed');
    const service = require('@adcp/sdk/reporting/service');
    const source = require('@adcp/sdk/reporting/source');
    ${check}
    `
  );
  writeFileSync(
    join(temporary, 'consumer.mjs'),
    `
    import assert from 'node:assert/strict';
    import * as storage from '@adcp/reporting-storage';
    import * as managed from '@adcp/reporting-storage/managed';
    import * as notifications from '@adcp/reporting-storage/notifications';
    import * as productionService from '@adcp/reporting-storage/service';
    import * as gcs from '@adcp/reporting-storage/gcs';
    import * as s3 from '@adcp/reporting-storage/s3';
    import * as azure from '@adcp/reporting-storage/azure';
    import * as bigquery from '@adcp/reporting-storage/bigquery';
    import * as sdkLedger from '@adcp/sdk/reporting/ledger';
    import * as sdkService from '@adcp/sdk/reporting/service';
    import * as sdkSource from '@adcp/sdk/reporting/source';
    const LOADED = {
      '@adcp/reporting-storage': storage,
      '@adcp/reporting-storage/managed': managed,
      '@adcp/reporting-storage/notifications': notifications,
      '@adcp/reporting-storage/service': productionService,
      '@adcp/reporting-storage/gcs': gcs,
      '@adcp/reporting-storage/s3': s3,
      '@adcp/reporting-storage/azure': azure,
      '@adcp/reporting-storage/bigquery': bigquery,
    };
    const EXPECTED = ${expected};
    const service = sdkService;
    const source = sdkSource;
    ${check}
    `
  );
  for (const file of ['consumer.cjs', 'consumer.mjs']) {
    execFileSync('node', [join(temporary, file)], { cwd: temporary, stdio: 'inherit' });
  }
  console.log('✅ Packed @adcp/sdk and @adcp/reporting-storage resolve and compose in CJS and ESM.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
