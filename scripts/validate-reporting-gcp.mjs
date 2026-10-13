#!/usr/bin/env node
/**
 * Live GCP validation for the Reliable Reporting integrations:
 *
 *   1. BigQuery warehouse sink (`@adcp/sdk/reporting/bigquery`)
 *   2. GCS row-object provider (`@adcp/sdk/reporting/gcs`)
 *
 * It runs the built SDK (`dist/`) against a real PostgreSQL ledger, a real
 * BigQuery project and a real GCS bucket, then prints a PASS / FAIL / INFO
 * report and a markdown block that can be pasted into a PR comment. It creates
 * only what it names with a per-run unique id (a BigQuery dataset, a GCS prefix
 * and PostgreSQL schemas) and removes them in `finally` unless KEEP=1.
 *
 *   npm run build
 *   npm install --no-save @google-cloud/bigquery @google-cloud/storage
 *   REPORTING_LEDGER_PG_URL=... GCP_BQ_PROJECT=... GCS_BUCKET=... \
 *     npm run validate:reporting-gcp -- --yes
 *
 * Configuration is environment variables only; credentials come from
 * Application Default Credentials (workload identity, `gcloud auth
 * application-default login`, or GOOGLE_APPLICATION_CREDENTIALS). Nothing
 * secret is read, written to disk or printed. See "Live GCP validation" in
 * docs/guides/REPORTING-OPERATIONS.md.
 *
 * The core is exported (`parseConfig`, `run`, `Report`) so
 * test/lib/reporting-gcp-validation-pg.test.js drives it against in-memory
 * BigQuery and Storage doubles.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SETUP = 'Setup';
const BQ = 'BigQuery sink';
const GCS = 'GCS row provider';
const CLEANUP = 'Cleanup';

const USAGE = `Live GCP validation for the reporting BigQuery sink and GCS row provider.

Usage: npm run validate:reporting-gcp -- --yes [--skip-bigquery] [--skip-gcs]

Environment:
  REPORTING_LEDGER_PG_URL  required  PostgreSQL URL the ledger runs on (fresh schemas are created and dropped)
  GCP_BQ_PROJECT           required* destination project for the temporary dataset (* unless --skip-bigquery)
  GCP_BQ_LOCATION          optional  dataset and job location (default US)
  GCP_CLIENT_PROJECT       optional  the BigQuery client's default project; set it different from
                                     GCP_BQ_PROJECT to exercise the cross-project path
  GCP_DATASET_PREFIX       optional  dataset name prefix (default adcp_sink_validation_)
  GCS_BUCKET               required* bucket under test (* unless --skip-gcs)
  GCS_PREFIX               optional  prefix you own for the test; a unique run folder is created beneath it
                                     (default adcp-reporting-validation)
  KEEP=1                   optional  keep the dataset, GCS objects and PostgreSQL schemas for inspection
  ADCP_SDK_ROOT            optional  another built adcp-client checkout (for example a PR branch) whose dist/ is
                                     tested; this script and its peers still come from the checkout running it
  CONFIRM=1 | --yes        required  acknowledge that resources will be created
  SKIP_BIGQUERY=1 | --skip-bigquery, SKIP_GCS=1 | --skip-gcs   skip a section

Exit status: 0 no FAIL, 1 at least one FAIL, 2 configuration problem or not confirmed.`;

const PROJECT = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/;
const LOCATION = /^[A-Za-z0-9-]{2,40}$/;
const BUCKET = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;
const DATASET_PREFIX = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
const OBJECT_PREFIX = /^[A-Za-z0-9_.=-]+(?:\/[A-Za-z0-9_.=-]+)*$/;
const KNOWN_FLAGS = new Set(['--yes', '--skip-bigquery', '--skip-gcs', '--help', '-h']);

export class ConfigError extends Error {
  constructor(problems) {
    super(problems.join('\n'));
    this.problems = problems;
  }
}

function truthy(value) {
  return value !== undefined && /^(1|true|yes)$/i.test(value);
}

function makeRunId() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${stamp}_${randomBytes(3).toString('hex')}`;
}

/** Parse env and flags into a config. Throws `ConfigError` listing every problem. */
export function parseConfig(env = process.env, argv = [], options = {}) {
  const problems = [];
  const flags = new Set(argv);
  for (const flag of flags) if (!KNOWN_FLAGS.has(flag)) problems.push(`unknown argument ${flag}`);
  const skipBigQuery = flags.has('--skip-bigquery') || truthy(env.SKIP_BIGQUERY);
  const skipGcs = flags.has('--skip-gcs') || truthy(env.SKIP_GCS);
  const runId = options.runId ?? makeRunId();
  const config = {
    help: flags.has('--help') || flags.has('-h'),
    pgUrl: env.REPORTING_LEDGER_PG_URL,
    bqProject: env.GCP_BQ_PROJECT || undefined,
    clientProject: env.GCP_CLIENT_PROJECT || undefined,
    location: env.GCP_BQ_LOCATION || 'US',
    datasetPrefix: env.GCP_DATASET_PREFIX || 'adcp_sink_validation_',
    bucket: env.GCS_BUCKET || undefined,
    gcsBasePrefix: (env.GCS_PREFIX || 'adcp-reporting-validation').replace(/^\/+|\/+$/g, ''),
    keep: truthy(env.KEEP),
    skipBigQuery,
    skipGcs,
    confirmed: flags.has('--yes') || truthy(env.CONFIRM),
    runId,
    // Built checkout whose dist/ is exercised; defaults to the checkout holding this script.
    sdkRoot: env.ADCP_SDK_ROOT ? path.resolve(env.ADCP_SDK_ROOT) : ROOT,
  };
  if (config.help) return config;
  let pgHost = '';
  let pgPassword = '';
  if (!config.pgUrl) problems.push('REPORTING_LEDGER_PG_URL is required');
  else {
    try {
      const url = new URL(config.pgUrl);
      if (!/^postgres(ql)?:$/.test(url.protocol)) throw new Error('protocol');
      pgPassword = decodeURIComponent(url.password);
      pgHost = `${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}`;
    } catch {
      problems.push('REPORTING_LEDGER_PG_URL is not a valid postgres:// URL');
    }
  }
  if (skipBigQuery && skipGcs) problems.push('both sections are skipped; nothing to validate');
  if (!skipBigQuery) {
    if (!config.bqProject) problems.push('GCP_BQ_PROJECT is required (or pass --skip-bigquery)');
    else if (!PROJECT.test(config.bqProject)) problems.push('GCP_BQ_PROJECT is not a valid project id');
    if (config.clientProject && !PROJECT.test(config.clientProject)) {
      problems.push('GCP_CLIENT_PROJECT is not a valid project id');
    }
    if (!LOCATION.test(config.location)) problems.push('GCP_BQ_LOCATION is not a valid location');
    if (!DATASET_PREFIX.test(config.datasetPrefix)) {
      problems.push('GCP_DATASET_PREFIX must be letters, digits and underscores, starting with a letter or _');
    }
  }
  if (!skipGcs) {
    if (!config.bucket) problems.push('GCS_BUCKET is required (or pass --skip-gcs)');
    else if (!BUCKET.test(config.bucket) || config.bucket.includes('..'))
      problems.push('GCS_BUCKET is not a valid name');
    if (
      !OBJECT_PREFIX.test(config.gcsBasePrefix) ||
      config.gcsBasePrefix.split('/').some(s => s === '.' || s === '..')
    ) {
      problems.push('GCS_PREFIX may contain only letters, digits and _.=- in each / separated segment');
    }
  }
  if (problems.length) throw new ConfigError(problems);
  config.pgDescription = pgHost;
  config.pgPassword = pgPassword;
  config.datasetId = `${config.datasetPrefix}${runId}`;
  config.gcsRunPrefix = `${config.gcsBasePrefix}/${runId}`;
  config.sinkPrefix = `adcp-validation-${runId}`;
  config.labels = { adcp_validation: 'true', adcp_run: runId };
  return config;
}

// ---------------------------------------------------------------------------
// Reporting

function redact(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) if (secret && secret.length > 3) out = out.split(secret).join('[redacted]');
  return out
    .replace(/ya29\.[\w.-]+/g, '[redacted]')
    .replace(/Bearer\s+[\w.~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, 'postgres://[redacted]')
    .replace(/"private_key"\s*:\s*"[^"]*"/g, '"private_key":"[redacted]"');
}

function errText(error, secrets = []) {
  const record = error && typeof error === 'object' ? error : {};
  const code = record.code !== undefined ? `[${record.code}] ` : '';
  const first = Array.isArray(record.errors) && record.errors[0]?.message ? ` (${record.errors[0].message})` : '';
  const message = error instanceof Error ? error.message : String(error);
  const text = redact(`${code}${message}${first}`, secrets).replace(/\s+/g, ' ');
  return text.length > 700 ? `${text.slice(0, 700)}...` : text;
}

export class Report {
  constructor({ print = line => console.log(line), secrets = [] } = {}) {
    this.entries = [];
    this.print = print;
    this.secrets = secrets;
    this.currentSection = undefined;
  }
  section(title) {
    this.currentSection = title;
    this.print(`\n== ${title} ==`);
  }
  add(section, status, name, detail = '', block) {
    const entry = { section, status, name, detail: redact(detail, this.secrets), block };
    this.entries.push(entry);
    if (section !== this.currentSection) this.section(section);
    this.print(`  [${status}] ${name}${entry.detail ? ` - ${entry.detail}` : ''}`);
    if (block) for (const line of block.split('\n')) this.print(`        ${line}`);
    return entry;
  }
  pass(section, name, detail, block) {
    return this.add(section, 'PASS', name, detail, block);
  }
  fail(section, name, detail, block) {
    return this.add(section, 'FAIL', name, detail, block);
  }
  info(section, name, detail, block) {
    return this.add(section, 'INFO', name, detail, block);
  }
  get failures() {
    return this.entries.filter(entry => entry.status === 'FAIL');
  }
  count(status) {
    return this.entries.filter(entry => entry.status === status).length;
  }
  /** Markdown for a PR comment. `mask` replaces project, bucket and similar names. */
  markdown(meta, mask = []) {
    const masked = text => {
      let out = String(text);
      for (const [from, to] of mask) if (from && from.length > 3) out = out.split(from).join(to);
      return out;
    };
    const cell = text =>
      masked(text)
        .replace(/\\/g, '\\\\')
        .replace(/\|/g, '\\|')
        .replace(/\s*\n\s*/g, ' ');
    const overall = this.failures.length ? 'FAIL' : 'PASS';
    const lines = [
      '### Live GCP validation: reporting BigQuery sink and GCS row provider',
      '',
      `**Result: ${overall}** (${this.count('PASS')} pass, ${this.count('FAIL')} fail, ${this.count('INFO')} info)`,
      '',
      ...meta.map(line => `- ${masked(line)}`),
      '',
      '| Section | Check | Result | Detail |',
      '| --- | --- | --- | --- |',
      ...this.entries.map(
        entry =>
          `| ${cell(entry.section)} | ${cell(entry.name)} | ${entry.status} | ${cell(entry.detail).slice(0, 400)} |`
      ),
    ];
    for (const entry of this.entries.filter(value => value.block)) {
      lines.push('', `<details><summary>${cell(entry.section)}: ${cell(entry.name)}</summary>`, '', '```json');
      lines.push(masked(entry.block), '```', '', '</details>');
    }
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Small helpers

const sleepReal = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** Resolves false after the delay without keeping the process alive (not the injectable `sleep`). */
function timeoutAfter(milliseconds) {
  return new Promise(resolve => setTimeout(() => resolve(false), milliseconds).unref());
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

function sequenceRows(count) {
  return Array.from({ length: count }, (_, index) => ({ ordinal: index, impressions: index }));
}

const sumOfSequence = count => (count * (count - 1)) / 2;

/** Run one named check; records PASS (with the returned detail) or FAIL. Resolves true on PASS. */
async function check(ctx, section, name, work) {
  try {
    ctx.signal?.throwIfAborted();
    const detail = await work();
    ctx.report.pass(section, name, typeof detail === 'string' ? detail : '');
    return true;
  } catch (error) {
    ctx.report.fail(section, name, errText(error, ctx.secrets));
    return false;
  }
}

/** Run one informational probe: never records FAIL, so it cannot change the exit status. */
async function probe(ctx, section, name, work) {
  try {
    ctx.signal?.throwIfAborted();
    const result = await work();
    ctx.report.info(section, name, result?.detail ?? '', result?.block);
  } catch (error) {
    ctx.report.info(section, name, `probe could not complete: ${errText(error, ctx.secrets)}`);
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL ledger scenarios

async function openLedger(ctx, label, { sink = false, storeOptions = {} } = {}) {
  const { sdk, config } = ctx;
  const schema = `adcp_validation_${config.runId}_${label}`;
  await ctx.admin.query(`CREATE SCHEMA "${schema}"`);
  ctx.schemas.push(schema);
  const pool = new ctx.Pool({ connectionString: config.pgUrl, options: `-c search_path="${schema}"`, max: 4 });
  ctx.pools.push(pool);
  await pool.query(sdk.ledger.REPORTING_LEDGER_MIGRATION);
  await pool.query(sdk.ledger.REPORTING_ROW_STORAGE_MIGRATION);
  if (sink) {
    await pool.query(sdk.ledger.REPORTING_LEDGER_CHANGES_MIGRATION);
    await pool.query(sdk.bigquery.REPORTING_WAREHOUSE_SINK_MIGRATION);
    await pool.query(sdk.bigquery.REPORTING_WAREHOUSE_SINK_MIGRATION); // idempotent
  }
  const store = new sdk.ledger.PostgresReportingLedgerStore(pool, {
    acknowledgeIsolatedDatabase: true,
    ...(sink ? { rowStorage: true, changeFeed: true } : {}),
    ...storeOptions,
  });
  await store.readyRowStorage();
  return { schema, pool, store };
}

async function newObligation(ctx, ledger, suffix, options = {}) {
  const fixture = await ctx.sdk.createRowStorageFixture({
    store: ledger.store,
    suffix,
    leaseMilliseconds: 1_800_000,
    ...options,
  });
  ledger.accountId = fixture.request.account.account_id;
  return fixture;
}

async function commit(ledger, fixture, id, revisionNumber, rows, supersedes) {
  const revision = fixture.revision(
    id,
    revisionNumber,
    rows,
    supersedes ? { supersedes_reporting_revision_id: supersedes } : {}
  );
  return ledger.store.commitRevision(revision, fixture.lease);
}

async function sinkState(ledger, name) {
  const { rows } = await ledger.pool.query(
    `SELECT committed_cursor, planned_to_cursor FROM adcp_reporting_warehouse_sinks WHERE sink_name = $1`,
    [name]
  );
  return rows[0];
}

// ---------------------------------------------------------------------------
// BigQuery section

function faultInjectingClient(real, sentLoads = []) {
  const failures = new Map();
  return {
    sentLoads,
    failNext(tableId, error) {
      failures.set(tableId, error);
    },
    dataset(datasetId, options) {
      const dataset = real.dataset(datasetId, options);
      return {
        table(tableId) {
          const table = dataset.table(tableId);
          return {
            async load(file, metadata) {
              sentLoads.push({ tableId, options: structuredClone(metadata) });
              const failure = failures.get(tableId);
              if (failure) {
                failures.delete(tableId);
                throw failure;
              }
              return table.load(file, metadata);
            },
          };
        },
      };
    },
    job: (...args) => real.job(...args),
    query: (...args) => real.query(...args),
  };
}

async function drain(ctx, sink, attempts = 6) {
  const outcomes = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await sink.runOnce();
      outcomes.push(`ok ${JSON.stringify(result)}`);
      if (result.idle) return { idle: true, outcomes };
    } catch (error) {
      outcomes.push(`error ${errText(error, ctx.secrets)}`);
      await ctx.sleep(3_000);
    }
  }
  return { idle: false, outcomes };
}

async function bigquerySection(ctx) {
  const { config, report, bigquery, sdk } = ctx;
  const dest = config.bqProject;
  const crossProject = ctx.clientProject !== dest;
  const table = id => `\`${dest}.${config.datasetId}.${id}\``;
  const query = async sql => (await bigquery.query({ query: sql, location: config.location }))[0];
  const counts = async (tableId, distinctExpression) => {
    const [row] = await query(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT ${distinctExpression}) AS distinct_n FROM ${table(tableId)}`
    );
    return { n: Number(row.n), distinct: Number(row.distinct_n) };
  };
  const rowCounts = tableId => counts(tableId, `CONCAT(reporting_revision_id, ':', CAST(ordinal AS STRING))`);
  const revisionCounts = tableId => counts(tableId, 'reporting_revision_id');

  report.section(BQ);
  report.info(
    BQ,
    'projects and location',
    `destination=${dest} client=${ctx.clientProject} location=${config.location} ` +
      (crossProject
        ? 'cross-project: load jobs, replay lookups and queries use different projects'
        : 'same project: set GCP_CLIENT_PROJECT to a different project to exercise the cross-project path')
  );

  const datasetRef = bigquery.dataset(config.datasetId, { projectId: dest, location: config.location });
  const created = await check(ctx, BQ, 'create temporary dataset', async () => {
    await datasetRef.create({
      labels: config.labels,
      // Safety net if cleanup is interrupted: tables expire on their own.
      defaultTableExpirationMs: String(48 * 3_600_000),
    });
    ctx.datasetCreated = true;
    return `${dest}:${config.datasetId}`;
  });
  if (!created) return;

  const sentLoads = [];
  const recorder = faultInjectingClient(bigquery, sentLoads);
  const sinkFor = (ledger, name, tables, extra = {}) =>
    sdk.bigquery.createBigQueryReportingWarehouseSinkV1({
      store: ledger.store,
      db: ledger.pool,
      bigquery: recorder,
      name: `${config.sinkPrefix}-${name}`,
      projectId: dest,
      datasetId: config.datasetId,
      rowsTableId: tables.rows,
      revisionsTableId: tables.revisions,
      location: config.location,
      // Scoped to the fixture account so unrelated open transactions in the
      // database cannot hold back the feed's snapshot horizon.
      account_id: ledger.accountId,
      // Deprecated and ignored by the sink; passed so the check below catches a regression
      // that would send it where BigQuery drops it.
      labels: config.labels,
      loadTimeoutMilliseconds: 120_000,
      maxRevisionsPerBatch: 50,
      ...extra,
    });
  const createTables = async (sink, withView) => {
    await query(sink.defaultTablesSql);
    if (withView) await query(sink.currentRowsViewSql);
  };

  await mainScenario();
  await crashScenario();
  await concurrentScenario();
  await staleReadScenario();
  await periodDateScenario();

  // -- 1. Load, counts, jobs, labels and the current_rows view ----------------
  async function mainScenario() {
    const tables = { rows: 'revision_rows', revisions: 'revisions' };
    let ledger;
    let sink;
    let fixtureA;
    let fixtureB;
    const expectedRows = 25 + 10 + 7;
    const ready = await check(ctx, BQ, 'ledger schema, migrations and committed revisions', async () => {
      ledger = await openLedger(ctx, 'main', { sink: true });
      fixtureA = await newObligation(ctx, ledger, 'maina');
      fixtureB = await newObligation(ctx, ledger, 'mainb');
      const r1 = await commit(ledger, fixtureA, `rrev_${config.runId}_a1`, 1, sequenceRows(25));
      const r2 = await commit(
        ledger,
        fixtureA,
        `rrev_${config.runId}_a2`,
        2,
        sequenceRows(10),
        `rrev_${config.runId}_a1`
      );
      const r3 = await commit(ledger, fixtureB, `rrev_${config.runId}_b1`, 1, sequenceRows(7));
      expect(r1.inserted && r2.inserted && r3.inserted, 'a revision was not inserted');
      sink = sinkFor(ledger, 'main', tables);
      return 'obligation A has 2 revisions (25 then 10 rows), obligation B has 1 revision (7 rows)';
    });
    if (!ready) return;
    const created = await check(ctx, BQ, 'create tables from defaultTablesSql and the current_rows view', async () => {
      await createTables(sink, true);
      return 'DDL ran in the destination dataset';
    });
    if (!created) return;

    let before;
    const ran = await check(ctx, BQ, 'runOnce loads every committed revision', async () => {
      before = await sinkState(ledger, `${config.sinkPrefix}-main`);
      const result = await sink.runOnce();
      expect(!result.idle, 'runOnce reported idle with committed revisions pending');
      expectEqual(result.revisions, 3, 'revisions loaded');
      expectEqual(result.rows, expectedRows, 'rows loaded');
      expect(result.missing.length === 0, `missing revisions reported: ${result.missing.join(',')}`);
      return JSON.stringify(result);
    });
    if (!ran) return;

    await check(ctx, BQ, 'row and revision counts in BigQuery match, with no duplicates', async () => {
      const rowTotals = await rowCounts(tables.rows);
      const revisionTotals = await revisionCounts(tables.revisions);
      expectEqual(rowTotals.n, expectedRows, 'rows table row count');
      expectEqual(rowTotals.distinct, expectedRows, 'rows table distinct (revision, ordinal) count');
      expectEqual(revisionTotals.n, 3, 'revisions table row count');
      expectEqual(revisionTotals.distinct, 3, 'revisions table distinct revision count');
      const [sum] = await query(
        `SELECT SUM(CAST(JSON_VALUE(\`row\`, '$.impressions') AS INT64)) AS total FROM ${table(tables.rows)}`
      );
      const expectedSum = sumOfSequence(25) + sumOfSequence(10) + sumOfSequence(7);
      expectEqual(Number(sum.total), expectedSum, 'sum of impressions in the JSON row column');
      return `rows=${rowTotals.n} revisions=${revisionTotals.n} impressions=${expectedSum}`;
    });

    let jobMetadata;
    await check(
      ctx,
      BQ,
      'load jobs exist in the destination project and location with deterministic job IDs',
      async () => {
        const state = await sinkState(ledger, `${config.sinkPrefix}-main`);
        expect(state.committed_cursor, 'the sink did not commit a cursor');
        const base = sdk.bigquery.reportingWarehouseJobIdV1(
          `${config.sinkPrefix}-main`,
          before?.committed_cursor ?? null,
          state.committed_cursor
        );
        const found = [];
        jobMetadata = {};
        for (const kind of ['rows', 'revs']) {
          const jobId = `${base}_${kind}`;
          const [metadata] = await bigquery.job(jobId, { projectId: dest, location: config.location }).getMetadata();
          expect(metadata, `no metadata for job ${jobId}`);
          jobMetadata[kind] = metadata;
          expectEqual(metadata.status?.state, 'DONE', `job ${jobId} state`);
          expect(!metadata.status?.errorResult, `job ${jobId} finished with an error`);
          expectEqual(metadata.jobReference?.jobId, jobId, 'jobReference.jobId');
          expectEqual(metadata.jobReference?.projectId, dest, `job ${jobId} jobReference.projectId`);
          expectEqual(
            String(metadata.jobReference?.location ?? '').toLowerCase(),
            config.location.toLowerCase(),
            `job ${jobId} jobReference.location`
          );
          const destination = metadata.configuration?.load?.destinationTable;
          expectEqual(destination?.projectId, dest, `job ${jobId} destination project`);
          expectEqual(destination?.datasetId, config.datasetId, `job ${jobId} destination dataset`);
          expectEqual(
            destination?.tableId,
            kind === 'rows' ? tables.rows : tables.revisions,
            `job ${jobId} destination table`
          );
          found.push(jobId);
        }
        return `${found.length} jobs, e.g. ${found[0]}`;
      }
    );

    if (crossProject) {
      await probe(ctx, BQ, 'the same job looked up through the client default project', async () => {
        const jobId = jobMetadata?.rows?.jobReference?.jobId;
        if (!jobId) return { detail: 'skipped: no job id' };
        try {
          const [metadata] = await bigquery.job(jobId, { location: config.location }).getMetadata();
          return {
            detail: `found in project ${metadata?.jobReference?.projectId}; the lookup is not project-scoped`,
          };
        } catch (error) {
          return {
            detail:
              `not found (${errText(error, ctx.secrets)}). Expected: the jobs live in the destination project, so a ` +
              `replay status check must pass projectId or it fails across projects (main omits it; PR #3197 passes it)`,
          };
        }
      });
    }

    // `labels` and `jobTimeoutMs` belong at configuration.*, but the official client builds a
    // local-file load's configuration.load from the load options and cannot set them there, and
    // BigQuery silently drops them from configuration.load (#3220). The sink therefore must not
    // send them, and enforces its deadline client-side by cancelling the job.
    await check(
      ctx,
      BQ,
      'the sink sends no job-level fields (labels, jobTimeoutMs) that BigQuery drops from configuration.load',
      async () => {
        expect(sentLoads.length >= 2, `expected the sink's load calls to be recorded, saw ${sentLoads.length}`);
        for (const { tableId, options } of sentLoads) {
          for (const field of ['labels', 'jobTimeoutMs']) {
            expect(!(field in options), `a load into ${tableId} sent ${field} inside configuration.load`);
          }
        }
        const configuration = jobMetadata?.rows?.configuration ?? {};
        for (const field of ['labels', 'jobTimeoutMs']) {
          expect(
            !(field in (configuration.load ?? {})),
            `BigQuery stored ${field} inside configuration.load (the service is expected to drop it)`
          );
        }
        return `${sentLoads.length} load calls carried neither field; stored job configuration keys: ${Object.keys(configuration).join(', ')}`;
      }
    );

    await check(
      ctx,
      BQ,
      'BigQuery accepts a cancel addressed with the destination project and location, and refuses wrong addresses',
      async () => {
        // Cancelling an already-finished job is accepted and changes nothing, so this proves the
        // addressing the sink uses on a client-side deadline (job(id, { projectId, location }).cancel()).
        const jobId = jobMetadata?.rows?.jobReference?.jobId;
        expect(jobId, 'no job id to cancel');
        const [response] = await bigquery.job(jobId, { projectId: dest, location: config.location }).cancel();
        expectEqual(response?.job?.jobReference?.projectId, dest, 'cancel response jobReference.projectId');
        expectEqual(response?.job?.jobReference?.jobId, jobId, 'cancel response jobReference.jobId');
        const [after] = await bigquery.job(jobId, { projectId: dest, location: config.location }).getMetadata();
        expectEqual(after.status?.state, 'DONE', 'job state after the cancel request');
        expect(!after.status?.errorResult, 'cancelling a finished job must not fail it');
        // Negative controls: a cancel is only meaningful if a wrong address is refused. A job that
        // does not exist is a 404, and so is the right job addressed through the client's default
        // project when the destination project differs.
        const refused = async (id, jobOptions) => {
          try {
            await bigquery.job(id, jobOptions).cancel();
            return false;
          } catch (error) {
            return error?.code === 404;
          }
        };
        expect(
          await refused(`${jobId}_does_not_exist`, { projectId: dest, location: config.location }),
          'cancelling an unknown job was not refused with 404'
        );
        if (crossProject) {
          expect(
            await refused(jobId, { location: config.location }),
            'cancelling the job through the client default project was not refused with 404'
          );
        }
        return crossProject
          ? `${jobId} stayed DONE; unknown job and wrong-project cancels were refused (404)`
          : `${jobId} stayed DONE; an unknown job cancel was refused (404). Same project: set GCP_CLIENT_PROJECT to a different project to also prove the project addressing`;
      }
    );

    await check(ctx, BQ, 'a second runOnce is idle and loads nothing', async () => {
      const result = await sink.runOnce();
      expect(result.idle && result.rows === 0 && result.revisions === 0, `not idle: ${JSON.stringify(result)}`);
      expectEqual((await rowCounts(tables.rows)).n, expectedRows, 'rows table count after the idle run');
      return JSON.stringify(result);
    });

    await check(ctx, BQ, 'current_rows returns exactly one revision per obligation', async () => {
      const result = await query(
        `SELECT reporting_obligation_id, COUNT(DISTINCT reporting_revision_id) AS revision_count, ` +
          `MIN(reporting_revision_id) AS reporting_revision_id, COUNT(*) AS n ` +
          `FROM ${table('current_rows')} GROUP BY reporting_obligation_id ORDER BY reporting_obligation_id`
      );
      expectEqual(result.length, 2, 'obligations in current_rows');
      const byObligation = new Map(result.map(row => [row.reporting_obligation_id, row]));
      const a = byObligation.get(fixtureA.obligation.reporting_obligation_id);
      const b = byObligation.get(fixtureB.obligation.reporting_obligation_id);
      expect(a && b, 'current_rows is missing an obligation');
      expectEqual(Number(a.revision_count), 1, 'obligation A revisions in the view');
      expectEqual(a.reporting_revision_id, `rrev_${config.runId}_a2`, 'obligation A current revision');
      expectEqual(Number(a.n), 10, 'obligation A rows in the view');
      expectEqual(Number(b.revision_count), 1, 'obligation B revisions in the view');
      expectEqual(b.reporting_revision_id, `rrev_${config.runId}_b1`, 'obligation B current revision');
      expectEqual(Number(b.n), 7, 'obligation B rows in the view');
      return 'A -> its second revision (10 rows), B -> its only revision (7 rows); 17 rows in total';
    });
  }

  // -- 1b. period_date is the source-timezone calendar date, not the UTC date -----
  async function periodDateScenario() {
    const tables = { rows: 'period_rows', revisions: 'period_revisions' };
    // Each period starts at an instant whose UTC date differs from its source-timezone date.
    const periods = [
      { suffix: 'pdla', zone: 'America/Los_Angeles', start: '2026-10-02T06:00:00.000Z', date: '2026-10-01' },
      { suffix: 'pdtk', zone: 'Asia/Tokyo', start: '2026-10-01T15:00:00.000Z', date: '2026-10-02' },
      { suffix: 'pdut', zone: 'UTC', start: '2026-10-01T15:00:00.000Z', date: '2026-10-01' },
    ];
    let ledger;
    let sink;
    const fixtures = [];
    const ready = await check(ctx, BQ, 'period_date: set up non-UTC obligations and load them', async () => {
      ledger = await openLedger(ctx, 'pdate', { sink: true });
      for (const { suffix, zone, start } of periods) {
        const fixture = await newObligation(ctx, ledger, suffix, {
          sourceTimezone: zone,
          periodStart: start,
          periodEnd: new Date(Date.parse(start) + 86_400_000).toISOString(),
        });
        fixtures.push(fixture);
        const result = await commit(ledger, fixture, `rrev_${config.runId}_${suffix}`, 1, sequenceRows(3));
        expect(result.inserted, `revision for ${zone} was not inserted`);
      }
      sink = sinkFor(ledger, 'pdate', tables);
      await createTables(sink, false);
      const result = await sink.runOnce();
      expectEqual(result.revisions, periods.length, 'revisions loaded');
      expectEqual(result.rows, periods.length * 3, 'rows loaded');
      return `${periods.length} obligations in ${periods.map(period => period.zone).join(', ')}`;
    });
    if (!ready) return;
    await check(ctx, BQ, 'period_date in BigQuery is the period start in its source timezone', async () => {
      for (const tableId of [tables.rows, tables.revisions]) {
        // CAST is also what makes a STRING column in place of DATE show up: DATE_DIFF refuses one.
        const result = await query(
          `SELECT DISTINCT reporting_obligation_id, CAST(period_date AS STRING) AS period_date ` +
            `FROM ${table(tableId)} WHERE DATE_DIFF(period_date, DATE '1970-01-01', DAY) IS NOT NULL`
        );
        // One (obligation, date) pair each: a regression that splits an obligation across dates adds rows.
        expectEqual(result.length, periods.length, `distinct (obligation, period_date) pairs in ${tableId}`);
        const byObligation = new Map(result.map(row => [row.reporting_obligation_id, row.period_date]));
        periods.forEach((period, index) => {
          expectEqual(
            byObligation.get(fixtures[index].obligation.reporting_obligation_id),
            period.date,
            `${tableId}.period_date for a ${period.zone} period starting ${period.start} ` +
              `(the UTC date is ${period.start.slice(0, 10)})`
          );
        });
      }
      return periods.map(period => `${period.zone} ${period.start} -> ${period.date}`).join('; ');
    });
  }

  // -- 2. Crash after the rows load, before the cursor commits ----------------
  async function crashScenario() {
    const tables = { rows: 'crash_rows', revisions: 'crash_revisions' };
    const name = `${config.sinkPrefix}-crash`;
    let ledger;
    let sink;
    let faulty;
    const ready = await check(ctx, BQ, 'crash replay: set up ledger, tables and revisions', async () => {
      ledger = await openLedger(ctx, 'crash', { sink: true });
      const fixture = await newObligation(ctx, ledger, 'crash');
      await commit(ledger, fixture, `rrev_${config.runId}_c1`, 1, sequenceRows(20));
      await commit(ledger, fixture, `rrev_${config.runId}_c2`, 2, sequenceRows(5), `rrev_${config.runId}_c1`);
      faulty = faultInjectingClient(bigquery, sentLoads);
      sink = sinkFor(ledger, 'crash', tables, { bigquery: faulty });
      await createTables(sink, false);
      return 'one obligation, revisions of 20 and 5 rows';
    });
    if (!ready) return;

    const crashed = await check(
      ctx,
      BQ,
      'crash replay: the run fails after the rows load, before the cursor commits',
      async () => {
        faulty.failNext(tables.revisions, new Error('injected failure: socket hang up'));
        let rejected;
        try {
          await sink.runOnce();
        } catch (error) {
          rejected = error;
        }
        expect(rejected, 'runOnce resolved although the revisions load was made to fail');
        expect(
          /injected failure/.test(String(rejected.message)),
          `unexpected error: ${errText(rejected, ctx.secrets)}`
        );
        const rowTotals = await rowCounts(tables.rows);
        expectEqual(rowTotals.n, 25, 'rows already loaded when the run failed');
        expectEqual((await revisionCounts(tables.revisions)).n, 0, 'revisions loaded when the run failed');
        const state = await sinkState(ledger, name);
        expect(!state.committed_cursor && state.planned_to_cursor, 'expected a durable plan and no committed cursor');
        return 'rows landed (25), revisions did not, the plan is retained and the cursor is not committed';
      }
    );
    if (!crashed) return;

    const replayed = await check(ctx, BQ, 'crash replay: the rerun resumes the same plan', async () => {
      const result = await sink.runOnce();
      expectEqual(result.revisions, 2, 'revisions loaded by the replay');
      expectEqual(result.rows, 25, 'rows reported by the replay');
      return JSON.stringify(result);
    });
    if (!replayed) {
      if (crossProject) {
        report.info(
          BQ,
          'crash replay hint',
          'A replay that fails here across projects usually means the 409 "job already exists" status check ' +
            'looked in the client default project instead of the destination project (fixed by PR #3197).'
        );
      }
      return;
    }
    await check(ctx, BQ, 'crash replay: no duplicate rows or revisions in BigQuery', async () => {
      const rowTotals = await rowCounts(tables.rows);
      const revisionTotals = await revisionCounts(tables.revisions);
      expectEqual(rowTotals.n, 25, 'rows table count after replay');
      expectEqual(rowTotals.distinct, 25, 'rows table distinct count after replay');
      expectEqual(revisionTotals.n, 2, 'revisions table count after replay');
      const state = await sinkState(ledger, name);
      expect(state.committed_cursor && !state.planned_to_cursor, 'the cursor did not commit after the replay');
      return 'rows=25 revisions=2, cursor committed';
    });
  }

  // -- 3. Two concurrent runs over one pending batch --------------------------
  async function concurrentScenario() {
    const tables = { rows: 'concurrent_rows', revisions: 'concurrent_revisions' };
    const label = '[#3196 probe: two concurrent runOnce() calls]';
    let ledger;
    let first;
    let second;
    const ready = await check(ctx, BQ, 'concurrent runs: set up ledger, tables and a pending batch', async () => {
      ledger = await openLedger(ctx, 'conc', { sink: true });
      const a = await newObligation(ctx, ledger, 'conca');
      const b = await newObligation(ctx, ledger, 'concb');
      await commit(ledger, a, `rrev_${config.runId}_k1`, 1, sequenceRows(30));
      await commit(ledger, b, `rrev_${config.runId}_k2`, 1, sequenceRows(10));
      first = sinkFor(ledger, 'concurrent', tables);
      second = sinkFor(ledger, 'concurrent', tables);
      await createTables(first, false);
      return 'two obligations, 40 rows pending, two sink instances sharing one name';
    });
    if (!ready) return;
    await probe(ctx, BQ, `${label} overlapping runs`, async () => {
      const settled = await Promise.allSettled([first.runOnce(), second.runOnce()]);
      const outcomes = settled.map((value, index) =>
        value.status === 'fulfilled'
          ? `run ${index + 1} ok ${JSON.stringify(value.value)}`
          : `run ${index + 1} rejected: ${errText(value.reason, ctx.secrets)}`
      );
      const drained = await drain(ctx, first);
      const rowTotals = await rowCounts(tables.rows);
      const revisionTotals = await revisionCounts(tables.revisions);
      const duplicates = rowTotals.n - rowTotals.distinct + (revisionTotals.n - revisionTotals.distinct);
      const verdict = duplicates
        ? `DUPLICATES OBSERVED (${rowTotals.n - rowTotals.distinct} extra rows, ${revisionTotals.n - revisionTotals.distinct} extra revisions); ` +
          `expected on main before PR #3197`
        : 'no duplicates observed';
      return {
        detail:
          `${label} ${verdict}. rows=${rowTotals.n} (distinct ${rowTotals.distinct}, expected 40), ` +
          `revisions=${revisionTotals.n} (distinct ${revisionTotals.distinct}, expected 2). ` +
          `${outcomes.join('; ')}; catch-up ${drained.idle ? 'reached idle' : 'did not reach idle'}: ${drained.outcomes.join('; ')}`,
      };
    });
  }

  // -- 4. Deterministic overlap: a run that read its state before another finished
  async function staleReadScenario() {
    const tables = { rows: 'stale_rows', revisions: 'stale_revisions' };
    const name = `${config.sinkPrefix}-stale`;
    const label = '[#3196 reproduction: stale run overlapping a completed run]';
    let ledger;
    let fixture;
    let slow;
    let fast;
    let gate;
    const ready = await check(ctx, BQ, 'stale-run overlap: set up ledger, tables and first revision', async () => {
      ledger = await openLedger(ctx, 'stale', { sink: true });
      fixture = await newObligation(ctx, ledger, 'stale');
      await commit(ledger, fixture, `rrev_${config.runId}_s1`, 1, sequenceRows(15));
      let release;
      let reached;
      const reachedPromise = new Promise(resolve => (reached = resolve));
      const released = new Promise(resolve => (release = resolve));
      let armed = true;
      gate = { reached: reachedPromise, release };
      // Pause the "slow" run right after it reads its sink state, so another run can finish first.
      const db = {
        async query(sql, params) {
          const result = await ledger.pool.query(sql, params);
          if (armed && /^\s*SELECT/i.test(sql) && /adcp_reporting_warehouse_sinks/.test(sql)) {
            armed = false;
            reached();
            await released;
          }
          return result;
        },
      };
      slow = sinkFor(ledger, 'stale', tables, { db });
      fast = sinkFor(ledger, 'stale', tables);
      await createTables(fast, false);
      return 'one obligation, first revision of 15 rows';
    });
    if (!ready) return;
    await probe(ctx, BQ, `${label} sequence`, async () => {
      const slowRun = slow.runOnce().then(
        value => `ok ${JSON.stringify(value)}`,
        error => `rejected: ${errText(error, ctx.secrets)}`
      );
      const reachedInTime = await Promise.race([gate.reached.then(() => true), timeoutAfter(30_000)]);
      if (!reachedInTime) {
        gate.release();
        await slowRun;
        return { detail: `${label} could not pause the first run (the sink's state read changed); nothing concluded` };
      }
      const fastResult = await fast.runOnce().then(
        value => `ok ${JSON.stringify(value)}`,
        error => `rejected: ${errText(error, ctx.secrets)}`
      );
      await commit(ledger, fixture, `rrev_${config.runId}_s2`, 2, sequenceRows(6), `rrev_${config.runId}_s1`);
      gate.release();
      const slowResult = await slowRun;
      const drained = await drain(ctx, fast);
      const rowTotals = await rowCounts(tables.rows);
      const revisionTotals = await revisionCounts(tables.revisions);
      const extraRows = rowTotals.n - rowTotals.distinct;
      const extraRevisions = revisionTotals.n - revisionTotals.distinct;
      const state = await sinkState(ledger, name);
      const verdict =
        extraRows || extraRevisions
          ? `DUPLICATES OBSERVED (${extraRows} extra rows, ${extraRevisions} extra revisions): the overlap reproduces #3196; expected on main, fixed by PR #3197`
          : 'no duplicates: the stale run did not load an overlapping batch (the behavior PR #3197 adds)';
      return {
        detail:
          `${label} ${verdict}. rows=${rowTotals.n} (distinct ${rowTotals.distinct}, expected 21), ` +
          `revisions=${revisionTotals.n} (distinct ${revisionTotals.distinct}, expected 2). ` +
          `completed run: ${fastResult}; stale run: ${slowResult}; ` +
          `catch-up ${drained.idle ? 'reached idle' : 'did not reach idle'}; cursor ${state?.committed_cursor ? 'committed' : 'not committed'}`,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// GCS section

function summarizeBucket(metadata) {
  const rules = (metadata.lifecycle?.rule ?? []).map(rule => {
    const condition = rule.condition ?? {};
    return `${rule.action?.type ?? '?'}[${Object.keys(condition).join(',')}${
      condition.matchesPrefix ? `=${JSON.stringify(condition.matchesPrefix)}` : ''
    }]`;
  });
  return {
    location: `${metadata.location ?? '?'} (${metadata.locationType ?? '?'}) ${metadata.storageClass ?? ''}`.trim(),
    uniformBucketLevelAccess: metadata.iamConfiguration?.uniformBucketLevelAccess?.enabled ?? false,
    publicAccessPrevention: metadata.iamConfiguration?.publicAccessPrevention ?? 'unspecified',
    versioning: metadata.versioning?.enabled ?? false,
    softDeleteSeconds: metadata.softDeletePolicy?.retentionDurationSeconds ?? 'unset',
    retentionPeriodSeconds: metadata.retentionPolicy?.retentionPeriod ?? 'none',
    lifecycleRules: rules.length ? rules.join('; ') : 'none',
  };
}

async function listRunObjects(ctx, bucket, prefix) {
  const [files] = await bucket.getFiles({ prefix, versions: true });
  return files;
}

async function gcsSection(ctx) {
  const { config, report, storage, sdk } = ctx;
  const bucket = storage.bucket(config.bucket);
  const runPrefix = config.gcsRunPrefix;
  const providerPrefix = `${runPrefix}/provider`;
  const rowsPrefix = `${runPrefix}/rows`;
  const location = { bucket: config.bucket };
  report.section(GCS);
  report.info(
    GCS,
    'bucket and prefix',
    `bucket=${config.bucket} run prefix=${runPrefix}/ (everything created is under it)`
  );

  const provider = sdk.gcs.createGcsReportingRowObjectProviderV1({ storage });

  await check(ctx, GCS, 'read the bucket policy (storage.buckets.get)', async () => {
    const [metadata] = await bucket.getMetadata();
    const summary = summarizeBucket(metadata);
    report.info(
      GCS,
      'bucket policy as seen by the probe',
      Object.entries(summary)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')
    );
    return 'readable';
  });

  await check(
    ctx,
    GCS,
    'provider probe: uniform bucket-level access, public access prevention, lifecycle rules',
    async () => {
      ctx.gcsTouched = true;
      await provider.probe({ location, prefix: providerPrefix }, { signal: AbortSignal.timeout(60_000) });
      await provider.probe({ location, prefix: rowsPrefix }, { signal: AbortSignal.timeout(60_000) });
      return 'accepted for both the conformance prefix and the row-binding prefix';
    }
  );

  await check(ctx, GCS, 'runReportingRowObjectProviderConformanceV1', async () => {
    ctx.gcsTouched = true;
    const passed = await sdk.ledger.runReportingRowObjectProviderConformanceV1(provider, {
      location,
      prefix: providerPrefix,
    });
    const expected = [
      'probe',
      'create',
      'create-only',
      'ranged-read',
      'version-pinned-read',
      'version-pinned-stat',
      'exact-version-delete',
      'write-unique-version',
    ];
    expect(JSON.stringify(passed) === JSON.stringify(expected), `unexpected check list: ${passed.join(',')}`);
    return passed.join(', ');
  });

  let ledger;
  let fixture;
  const rows = Array.from({ length: 300 }, (_, index) => ({ ordinal: index, label: `row-${index}`, value: index * 3 }));
  const revisionId = `rrev_${config.runId}_g1`;
  const binding = { kind: 'object', provider: 'gcs', location, prefix: rowsPrefix };
  const storeOptions = () => ({ rowStorage: { bindings: { objects: binding }, providers: { gcs: provider } } });
  const ready = await check(ctx, GCS, 'object-binding ledger on the bucket: schema and migrations', async () => {
    ledger = await openLedger(ctx, 'gcsrows', { storeOptions: storeOptions() });
    fixture = await newObligation(ctx, ledger, 'gcsrows');
    return `binding prefix ${rowsPrefix}`;
  });
  if (!ready) return;

  let objectRef;
  await check(ctx, GCS, 'commit a revision through the object binding and find its object in the bucket', async () => {
    ctx.gcsTouched = true;
    const result = await commit(ledger, fixture, revisionId, 1, rows);
    expect(result.inserted, 'commitRevision did not insert');
    const chunks = (
      await ledger.pool.query(`SELECT object_ref, compression FROM adcp_reporting_row_chunks WHERE row_set_id = $1`, [
        revisionId,
      ])
    ).rows;
    expect(chunks.length >= 1, 'no object chunk was recorded for the revision');
    objectRef = chunks[0].object_ref;
    expect(objectRef.startsWith(`${rowsPrefix}/`), `object key is outside the binding prefix`);
    const listed = (await listRunObjects(ctx, bucket, `${rowsPrefix}/`)).map(file => file.name);
    expect(listed.includes(objectRef), 'the recorded object is not in the bucket listing');
    expect(!objectRef.includes(fixture.request.account.account_id), 'the object key carries the raw account id');
    return `${chunks.length} object(s), compression=${chunks[0].compression}`;
  });
  if (!objectRef) return;

  await check(ctx, GCS, 'read the revision back from GCS, verified against the recorded digests', async () => {
    const account = fixture.request.account.account_id;
    const full = await ledger.store.getRevision(revisionId, account);
    expect(isDeepStrictEqual(full.rows, rows), 'getRevision rows differ from the committed rows');
    const page = await ledger.store.readRevisionRows({
      reporting_revision_id: revisionId,
      account_id: account,
      offset: 100,
      limit: 50,
    });
    expect(page && page.total === rows.length, 'readRevisionRows total differs');
    expect(isDeepStrictEqual(page.rows, rows.slice(100, 150)), 'readRevisionRows page differs');
    // A second store instance with the same binding reads through the same provider.
    const other = new sdk.ledger.PostgresReportingLedgerStore(ledger.pool, {
      acknowledgeIsolatedDatabase: true,
      ...storeOptions(),
    });
    const again = await other.getRevision(revisionId, account);
    expect(isDeepStrictEqual(again.rows, rows), 'a second store read different rows');
    return `${rows.length} rows verified; page 100-149 matched`;
  });

  await check(ctx, GCS, 'replaying the commit uploads nothing new', async () => {
    const before = (await listRunObjects(ctx, bucket, `${rowsPrefix}/`)).length;
    const replay = await commit(ledger, fixture, revisionId, 1, rows);
    expectEqual(replay.inserted, false, 'replay inserted');
    expectEqual((await listRunObjects(ctx, bucket, `${rowsPrefix}/`)).length, before, 'objects after replay');
    return `${before} object(s) before and after`;
  });
}

// ---------------------------------------------------------------------------
// Cleanup

async function cleanup(ctx) {
  const { config, report } = ctx;
  const closePools = async () => {
    for (const pool of ctx.pools) await pool.end().catch(() => {});
    ctx.pools.length = 0;
  };
  if (config.keep) {
    await closePools();
    const kept = [];
    if (ctx.datasetCreated) kept.push(`BigQuery dataset ${config.bqProject}:${config.datasetId}`);
    if (ctx.gcsTouched) kept.push(`GCS objects under gs://${config.bucket}/${config.gcsRunPrefix}/`);
    for (const schema of ctx.schemas) kept.push(`PostgreSQL schema ${schema}`);
    report.info(
      CLEANUP,
      'KEEP=1: nothing was deleted',
      kept.length
        ? `left in place: ${kept.join('; ')}. Remove with: bq rm -r -f -d ${config.bqProject}:${config.datasetId} ; ` +
            `gcloud storage rm -r gs://${config.bucket}/${config.gcsRunPrefix}/ ; DROP SCHEMA ... CASCADE`
        : 'nothing had been created'
    );
    await ctx.admin?.end().catch(() => {});
    return;
  }
  await closePools();
  if (ctx.gcsTouched) {
    await check({ ...ctx, signal: undefined }, CLEANUP, 'delete the GCS objects under the run prefix', async () => {
      const prefix = `${config.gcsRunPrefix}/`;
      const bucket = ctx.storage.bucket(config.bucket);
      const files = await listRunObjects(ctx, bucket, prefix);
      for (const file of files) {
        // Never delete outside the unique prefix this run created.
        if (!file.name.startsWith(prefix)) throw new Error(`refusing to delete ${file.name}: outside the run prefix`);
        const generation = file.metadata?.generation ?? file.generation;
        await (generation === undefined ? bucket.file(file.name) : bucket.file(file.name, { generation })).delete({
          ignoreNotFound: true,
        });
      }
      const remaining = (await listRunObjects(ctx, bucket, prefix)).length;
      expectEqual(remaining, 0, 'objects remaining under the run prefix');
      return `deleted ${files.length} object version(s)`;
    });
  }
  if (ctx.datasetCreated) {
    await check({ ...ctx, signal: undefined }, CLEANUP, 'delete the temporary BigQuery dataset', async () => {
      if (!config.datasetId.startsWith(config.datasetPrefix)) throw new Error('refusing to delete a foreign dataset');
      await ctx.bigquery
        .dataset(config.datasetId, { projectId: config.bqProject, location: config.location })
        .delete({ force: true });
      return `${config.bqProject}:${config.datasetId}`;
    });
  }
  if (ctx.schemas.length) {
    await check({ ...ctx, signal: undefined }, CLEANUP, 'drop the PostgreSQL schemas', async () => {
      for (const schema of ctx.schemas) {
        if (!schema.startsWith(`adcp_validation_${config.runId}_`))
          throw new Error('refusing to drop a foreign schema');
        await ctx.admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
      return `${ctx.schemas.length} schema(s)`;
    });
  }
  await ctx.admin?.end().catch(() => {});
}

// ---------------------------------------------------------------------------
// Entry points

/**
 * Run the validation. `deps`: `{ sdk, Pool, bigquery, storage, report, clientProject?, sleep?, signal? }`.
 * Resolves with the report; the caller derives the exit status from `report.failures`.
 */
export async function run(config, deps) {
  const report = deps.report ?? new Report();
  const ctx = {
    config,
    report,
    sdk: deps.sdk,
    Pool: deps.Pool,
    bigquery: deps.bigquery,
    storage: deps.storage,
    clientProject: deps.clientProject ?? config.clientProject ?? config.bqProject,
    sleep: deps.sleep ?? sleepReal,
    signal: deps.signal,
    secrets: [config.pgUrl, config.pgPassword].filter(Boolean),
    schemas: [],
    pools: [],
    datasetCreated: false,
    gcsTouched: false,
    admin: undefined,
  };
  report.secrets = ctx.secrets;
  try {
    ctx.admin = new ctx.Pool({ connectionString: config.pgUrl, max: 2 });
    const reachable = await check(ctx, SETUP, 'PostgreSQL reachable and able to create schemas', async () => {
      await ctx.admin.query('SELECT 1');
      const probeSchema = `adcp_validation_${config.runId}_probe`;
      await ctx.admin.query(`CREATE SCHEMA "${probeSchema}"`);
      await ctx.admin.query(`DROP SCHEMA "${probeSchema}"`);
      return config.pgDescription;
    });
    if (reachable) {
      if (!config.skipBigQuery) await bigquerySection(ctx);
      if (!config.skipGcs) await gcsSection(ctx);
    }
  } catch (error) {
    report.fail('Run', 'unexpected error', errText(error, ctx.secrets));
  } finally {
    try {
      await cleanup(ctx);
    } catch (error) {
      report.fail(CLEANUP, 'cleanup crashed', errText(error, ctx.secrets));
    }
  }
  return report;
}

function loadSdk(sdkRoot) {
  const modules = {
    ledger: 'dist/lib/reporting/ledger/index.js',
    bigquery: 'dist/lib/reporting/bigquery/index.js',
    gcs: 'dist/lib/reporting/gcs/index.js',
  };
  const missing = Object.values(modules).filter(file => !existsSync(path.join(sdkRoot, file)));
  if (missing.length) {
    throw new SetupError([`the built SDK is missing (${missing[0]}); run \`npm run build\` in ${sdkRoot}`]);
  }
  // The fixture builds revisions from the SDK under test when its checkout has the helper.
  const helper = 'test/helpers/reporting-row-storage-fixture.js';
  const fixtureHelper = existsSync(path.join(sdkRoot, helper)) ? path.join(sdkRoot, helper) : path.join(ROOT, helper);
  return {
    ledger: require(path.join(sdkRoot, modules.ledger)),
    bigquery: require(path.join(sdkRoot, modules.bigquery)),
    gcs: require(path.join(sdkRoot, modules.gcs)),
    createRowStorageFixture: require(fixtureHelper).createRowStorageFixture,
  };
}

class SetupError extends Error {
  constructor(problems) {
    super(problems.join('\n'));
    this.problems = problems;
  }
}

function loadPeer(name) {
  const attempts = [require, createRequire(path.join(process.cwd(), 'noop.js'))];
  for (const resolver of attempts) {
    try {
      return { module: resolver(name), version: peerVersion(resolver, name) };
    } catch (error) {
      if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  return undefined;
}

function peerVersion(resolver, name) {
  try {
    return JSON.parse(readFileSync(resolver.resolve(`${name}/package.json`), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

async function identityOf(client) {
  try {
    const credentials = await client.authClient?.getCredentials?.();
    if (credentials?.client_email) return credentials.client_email;
  } catch {
    /* fall through */
  }
  return 'unknown (ADC did not expose an email; check `gcloud auth list` or the workload identity binding)';
}

function gitInfo(sdkRoot) {
  const git = args => {
    try {
      return execFileSync('git', args, { cwd: sdkRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return undefined;
    }
  };
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const sha = git(['rev-parse', '--short', 'HEAD']);
  const dirty = git(['status', '--porcelain', '--', 'src', 'dist']) ? ' (uncommitted changes)' : '';
  return sha ? `${branch ?? 'detached'}@${sha}${dirty}` : 'not a git checkout';
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let config;
  try {
    config = parseConfig(env, argv);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`Configuration problems:\n${error.problems.map(problem => `  - ${problem}`).join('\n')}\n\n${USAGE}`);
    return 2;
  }
  if (config.help) {
    console.log(USAGE);
    return 0;
  }

  let Pool;
  let sdk;
  const peers = {};
  try {
    sdk = loadSdk(config.sdkRoot);
    Pool = require('pg').Pool;
    const needed = [];
    if (!config.skipBigQuery) needed.push('@google-cloud/bigquery');
    if (!config.skipGcs) needed.push('@google-cloud/storage');
    const missing = [];
    for (const name of needed) {
      peers[name] = loadPeer(name);
      if (!peers[name]) missing.push(name);
    }
    if (missing.length) {
      throw new SetupError([
        `missing optional peer package(s): ${missing.join(', ')}`,
        `install them without touching package.json:  npm install --no-save ${missing.join(' ')}`,
      ]);
    }
  } catch (error) {
    const problems = error instanceof SetupError ? error.problems : [errText(error)];
    console.error(`Setup problems:\n${problems.map(problem => `  - ${problem}`).join('\n')}`);
    return 2;
  }

  const clientProject = config.clientProject ?? config.bqProject;
  const deps = { sdk, Pool, clientProject };
  if (!config.skipBigQuery) {
    const { BigQuery } = peers['@google-cloud/bigquery'].module;
    deps.bigquery = new BigQuery(clientProject ? { projectId: clientProject } : {});
  }
  if (!config.skipGcs) {
    const { Storage } = peers['@google-cloud/storage'].module;
    deps.storage = new Storage(clientProject ? { projectId: clientProject } : {});
  }

  const identity = await identityOf(deps.bigquery ?? deps.storage);
  const pkg = JSON.parse(readFileSync(path.join(config.sdkRoot, 'package.json'), 'utf8'));
  const meta = [
    `SDK: \`@adcp/sdk ${pkg.version}\` built from \`${gitInfo(config.sdkRoot)}\`, Node ${process.version}`,
    `Peers: ${Object.entries(peers)
      .map(([name, peer]) => `\`${name} ${peer.version}\``)
      .join(', ')}`,
    ...(config.skipBigQuery
      ? ['BigQuery section skipped']
      : [
          `BigQuery: destination project \`${config.bqProject}\`, client project \`${clientProject}\` (${
            clientProject === config.bqProject ? 'same project' : 'cross-project'
          }), location \`${config.location}\``,
        ]),
    ...(config.skipGcs
      ? ['GCS section skipped']
      : [`GCS: bucket \`${config.bucket}\`, run prefix \`${config.gcsRunPrefix}/\``]),
    `Run id \`${config.runId}\`, cleanup ${config.keep ? 'skipped (KEEP=1)' : 'enabled'}`,
  ];

  console.log('Live GCP validation: reporting BigQuery sink and GCS row provider');
  console.log('\nPreflight');
  console.log(`  identity (ADC)      ${identity}`);
  console.log(`  ledger database     ${config.pgDescription} (fresh schemas adcp_validation_${config.runId}_*)`);
  if (!config.skipBigQuery) {
    console.log(`  destination project ${config.bqProject}`);
    console.log(
      `  client project      ${clientProject}${clientProject === config.bqProject ? ' (same: cross-project path not exercised)' : ''}`
    );
    console.log(`  location            ${config.location}`);
    console.log(`  temporary dataset   ${config.datasetId}`);
  }
  if (!config.skipGcs) {
    console.log(`  bucket              ${config.bucket}`);
    console.log(`  run prefix          ${config.gcsRunPrefix}/`);
  }
  console.log(
    `  cleanup             ${config.keep ? 'DISABLED (KEEP=1)' : 'delete everything created above in finally'}`
  );
  if (!config.confirmed) {
    console.error('\nNothing was created. Re-run with --yes (or CONFIRM=1) to create these resources.');
    return 2;
  }

  const controller = new AbortController();
  let interrupts = 0;
  const onSignal = name => () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130);
    console.error(`\n${name} received: finishing the current step, then cleaning up. Signal again to force exit.`);
    controller.abort(new Error(`${name} received`));
  };
  process.once('SIGINT', onSignal('SIGINT'));
  process.once('SIGTERM', onSignal('SIGTERM'));

  const report = new Report({ secrets: [config.pgUrl, config.pgPassword].filter(Boolean) });
  await run(config, { ...deps, report, signal: controller.signal });

  const mask = [
    [config.bqProject, '<destination-project>'],
    ...(clientProject !== config.bqProject ? [[clientProject, '<client-project>']] : []),
    [config.bucket, '<bucket>'],
  ].filter(([from]) => from);
  console.log('\nSummary');
  console.log(`  ${report.count('PASS')} pass, ${report.count('FAIL')} fail, ${report.count('INFO')} info`);
  console.log('\nMarkdown for the PR comment (project and bucket names are masked):\n');
  console.log(report.markdown(meta, mask));
  return report.failures.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(
    code => process.exit(code),
    error => {
      console.error(`validate-reporting-gcp crashed: ${errText(error)}`);
      process.exit(1);
    }
  );
}
