#!/usr/bin/env node
/**
 * Test runner for `@adcp/reporting-storage`. It groups the suites the way CI runs them against PostgreSQL.
 *
 *   node scripts/run-tests.mjs                     parallel group, then the serial group
 *   node scripts/run-tests.mjs --group parallel    every file except the serial set, in parallel (capped)
 *   node scripts/run-tests.mjs --group serial      the change-feed ordering files, one at a time
 *   node scripts/run-tests.mjs --group chunked     the chunked-row-storage pass (REPORTING_ROW_STORAGE=chunked)
 *   node scripts/run-tests.mjs --list              print the groups and exit
 *   node scripts/run-tests.mjs test/a.test.js ...  run just those files in one process
 *
 * The PostgreSQL suites read REPORTING_LEDGER_PG_URL (the lifecycle reference reads REPORTING_LIFECYCLE_PG_URL)
 * and skip without it. They need a PostgreSQL 13+ server whose role can create schemas and databases. Set
 * REPORTING_REQUIRE_POSTGRES=1 (CI does) to refuse to start when a URL the group needs is missing, so a renamed
 * variable cannot turn every database suite into a silent skip. Build the SDK and this package first
 * (`npm run build` at the repository root): the tests load both from `dist/`.
 *
 * The serial group needs an otherwise idle PostgreSQL cluster. The change feeds hold a page back while any older
 * transaction is open, and that horizon is cluster-wide, so another session's open write transaction (a parallel
 * run, or another project's tests on the same server) makes those suites wait or fail.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDirectory = path.join(packageRoot, 'test');

/**
 * The change feeds hold a page back while an older transaction is open, and `xmin` is cluster-wide. These
 * files either hold a transaction open on purpose or read the feed until it is empty, so they must not
 * overlap other files' write transactions, or each other's.
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

/** Each PostgreSQL file opens a few pools, so a many-core machine must not open hundreds of connections. */
const PARALLEL_FILES = Math.max(
  1,
  Math.min(Number(process.env.REPORTING_TEST_CONCURRENCY) || 4, availableParallelism())
);

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

/** The PostgreSQL URLs a group reads, so a missing one can fail the run instead of skipping its suites. */
const REQUIRED_ENV = {
  default: ['REPORTING_LEDGER_PG_URL', 'REPORTING_LIFECYCLE_PG_URL'],
  parallel: ['REPORTING_LEDGER_PG_URL', 'REPORTING_LIFECYCLE_PG_URL'],
  serial: ['REPORTING_LEDGER_PG_URL'],
  chunked: ['REPORTING_LEDGER_PG_URL'],
};

function requireBuild() {
  const sdk = path.resolve(packageRoot, '..', '..', 'dist', 'lib', 'index.js');
  const own = path.join(packageRoot, 'dist', 'index.js');
  for (const file of [sdk, own]) {
    if (!existsSync(file)) {
      console.error(
        `${path.relative(process.cwd(), file)} is missing. Run \`npm run build\` at the repository root first.`
      );
      process.exit(2);
    }
  }
  // A stale build tests yesterday's code: compare the newest source file with the built entry point.
  const newest = dir =>
    readdirSync(dir, { withFileTypes: true }).reduce((latest, entry) => {
      const full = path.join(dir, entry.name);
      return Math.max(latest, entry.isDirectory() ? newest(full) : statSync(full).mtimeMs);
    }, 0);
  if (newest(path.join(packageRoot, 'src')) > statSync(own).mtimeMs + 1000) {
    console.error(
      'packages/reporting-storage/src is newer than its dist/. Run `npm run build` at the repository root first.'
    );
    process.exit(2);
  }
}

function run(files, { concurrency, env = {} } = {}) {
  if (files.length === 0) return 0;
  const result = spawnSync(
    process.execPath,
    [
      '--test',
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
// Positional arguments are files; the value that follows `--group` is not one.
const explicit = args.filter((arg, index) => !arg.startsWith('--') && (groupIndex === -1 || index !== groupIndex + 1));

if (!['default', 'parallel', 'serial', 'chunked'].includes(group) || (groupIndex !== -1 && group === 'default')) {
  console.error(`Unknown group "${group}". Use parallel, serial or chunked.`);
  process.exit(2);
}
requireBuild();
if (explicit.length === 0 && process.env.REPORTING_REQUIRE_POSTGRES === '1') {
  const absent = REQUIRED_ENV[group].filter(name => !process.env[name]);
  if (absent.length > 0) {
    console.error(
      `REPORTING_REQUIRE_POSTGRES=1 and ${absent.join(', ')} is not set: the PostgreSQL suites would be skipped.`
    );
    process.exit(2);
  }
}

let status = 0;
if (explicit.length > 0) {
  status = run(explicit.map(file => path.relative(testDirectory, path.resolve(file))));
} else if (group === 'default') {
  // Both groups always run, so one failure does not hide the other's result.
  const parallel = run(groups.parallel, { concurrency: PARALLEL_FILES });
  const serial = run(groups.serial, { concurrency: 1 });
  status = parallel || serial;
} else if (group === 'parallel') {
  status = run(groups.parallel, { concurrency: PARALLEL_FILES });
} else if (group === 'serial') {
  status = run(groups.serial, { concurrency: 1 });
} else {
  status = run(groups.chunked, { concurrency: PARALLEL_FILES, env: { REPORTING_ROW_STORAGE: 'chunked' } });
}
process.exit(status);
