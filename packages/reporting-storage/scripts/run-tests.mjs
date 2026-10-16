#!/usr/bin/env node
/**
 * Test runner for `@adcp/reporting-storage`. It groups the suites the way CI runs them against PostgreSQL.
 *
 *   node scripts/run-tests.mjs                     parallel group, then the serial group
 *   node scripts/run-tests.mjs --group parallel    every file except the serial set, at node's default concurrency
 *   node scripts/run-tests.mjs --group serial      the change-feed ordering files, one at a time
 *   node scripts/run-tests.mjs --group chunked     the chunked-row-storage pass (REPORTING_ROW_STORAGE=chunked)
 *   node scripts/run-tests.mjs --list              print the groups and exit
 *   node scripts/run-tests.mjs path/to/a.test.js   run just those files (one process, default concurrency)
 *
 * The PostgreSQL suites read REPORTING_LEDGER_PG_URL (or DATABASE_URL) and skip without it. They need a
 * PostgreSQL 13+ server whose `postgres` role can create schemas and databases; the lifecycle reference reads
 * REPORTING_LIFECYCLE_PG_URL. Build the SDK and this package first (`npm run build` at the repository root):
 * the tests load both from `dist/`.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDirectory = path.join(packageRoot, 'test');

/**
 * The change feeds hold a page back while an older transaction is open, and `xmin` is cluster-wide. These
 * files either hold a transaction open on purpose or read the feed until it is empty, so they must not overlap
 * other files' write transactions, or each other's.
 */
export const SERIAL_TESTS = [
  'reliable-reporting-core-maintenance-pg.test.js',
  'reporting-bigquery-sink-pg.test.js',
  // Drives the BigQuery sink (and so the account change feed) end to end against in-memory doubles.
  'reporting-gcp-validation-pg.test.js',
  'reporting-head-of-line-pg.test.js',
  'reporting-host-reads-pg.test.js',
  'reporting-row-orphan-collector-pg.test.js',
  'reporting-row-retention-pg.test.js',
];

/** Re-run with `REPORTING_ROW_STORAGE=chunked`, which stores rows as verified chunks instead of inline. */
export const CHUNKED_TESTS = [
  'reliable-reporting-production-pg.test.js',
  'reporting-ledger-pg.test.js',
  'reporting-ledger-writer-fence-pg.test.js',
  'reporting-managed-delivery-pg.test.js',
  'reporting-notification-activity-pg.test.js',
  'reporting-status-ingest-pg.test.js',
];

const allTests = readdirSync(testDirectory)
  .filter(name => name.endsWith('.test.js'))
  .sort();
const missing = [...SERIAL_TESTS, ...CHUNKED_TESTS].filter(name => !allTests.includes(name));
if (missing.length > 0) throw new Error(`run-tests.mjs names files that do not exist: ${missing.join(', ')}`);

const groups = {
  parallel: allTests.filter(name => !SERIAL_TESTS.includes(name)),
  serial: SERIAL_TESTS,
  chunked: CHUNKED_TESTS,
};

function run(files, { concurrency, env = {} } = {}) {
  if (files.length === 0) return 0;
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-force-exit',
      '--test-timeout=120000',
      ...(concurrency ? [`--test-concurrency=${concurrency}`] : []),
      ...files.map(file => path.join('test', file)),
    ],
    { cwd: packageRoot, stdio: 'inherit', env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? 'test', ...env } }
  );
  return result.status ?? 1;
}

const args = process.argv.slice(2);
if (args.includes('--list')) {
  console.log(JSON.stringify(groups, null, 2));
  process.exit(0);
}
const groupIndex = args.indexOf('--group');
const group = groupIndex === -1 ? 'default' : args[groupIndex + 1];
const explicit = args.filter((arg, index) => !arg.startsWith('--') && index !== groupIndex + 1);

let status = 0;
if (explicit.length > 0) {
  status = run(explicit.map(file => path.relative(testDirectory, path.resolve(file))));
} else if (group === 'default') {
  // Both groups always run, so one failure does not hide the other's result.
  const parallel = run(groups.parallel);
  const serial = run(groups.serial, { concurrency: 1 });
  status = parallel || serial;
} else if (group === 'parallel') {
  status = run(groups.parallel);
} else if (group === 'serial') {
  status = run(groups.serial, { concurrency: 1 });
} else if (group === 'chunked') {
  status = run(groups.chunked, { env: { REPORTING_ROW_STORAGE: 'chunked' } });
} else {
  console.error(`Unknown group "${group}". Use parallel, serial or chunked.`);
  status = 2;
}
process.exit(status);
