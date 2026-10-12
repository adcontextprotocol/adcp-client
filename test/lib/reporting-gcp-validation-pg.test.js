/**
 * Drives scripts/validate-reporting-gcp.mjs against in-memory BigQuery and
 * Storage doubles and a real PostgreSQL, so the script's logic (configuration,
 * checks, reporting, cleanup safety) is exercised without GCP credentials.
 * It does not prove anything about real BigQuery or GCS behavior; that is what
 * the live run is for.
 *
 * REPORTING_LEDGER_PG_URL=postgres://localhost/test node --test test/lib/reporting-gcp-validation-pg.test.js
 */
const assert = require('node:assert/strict');
const { after, before, describe, test } = require('node:test');

const { createRowStorageFixture } = require('../helpers/reporting-row-storage-fixture.js');
const { createFakeBigQuery } = require('../helpers/fake-bigquery.js');
const { createFakeStorage } = require('../helpers/fake-gcs-storage.js');

const DATABASE_URL = process.env.REPORTING_LEDGER_PG_URL;

const baseEnv = () => ({
  REPORTING_LEDGER_PG_URL: DATABASE_URL ?? 'postgres://localhost/test',
  GCP_BQ_PROJECT: 'dest-project-1',
  GCS_BUCKET: 'rows-bucket',
});

describe('validate-reporting-gcp configuration', () => {
  let script;
  before(async () => {
    script = await import('../../scripts/validate-reporting-gcp.mjs');
  });

  test('requires the documented variables and names every problem', () => {
    assert.throws(
      () => script.parseConfig({}, []),
      error =>
        error instanceof script.ConfigError &&
        error.problems.some(problem => /REPORTING_LEDGER_PG_URL is required/.test(problem)) &&
        error.problems.some(problem => /GCP_BQ_PROJECT is required/.test(problem)) &&
        error.problems.some(problem => /GCS_BUCKET is required/.test(problem))
    );
    assert.throws(() => script.parseConfig({ ...baseEnv(), GCP_BQ_PROJECT: 'Bad Project' }, []), /not a valid project/);
    assert.throws(() => script.parseConfig({ ...baseEnv(), GCS_PREFIX: 'a/../b' }, []), /GCS_PREFIX/);
    assert.throws(() => script.parseConfig(baseEnv(), ['--bogus']), /unknown argument/);
    assert.throws(() => script.parseConfig(baseEnv(), ['--skip-bigquery', '--skip-gcs']), /nothing to validate/);
  });

  test('derives unique names, defaults and the confirmation gate', () => {
    const config = script.parseConfig(baseEnv(), [], { runId: '20261012101530_abc123' });
    assert.equal(config.location, 'US');
    assert.equal(config.datasetId, 'adcp_sink_validation_20261012101530_abc123');
    assert.equal(config.gcsRunPrefix, 'adcp-reporting-validation/20261012101530_abc123');
    assert.equal(config.confirmed, false);
    assert.equal(script.parseConfig({ ...baseEnv(), CONFIRM: '1' }, []).confirmed, true);
    assert.equal(script.parseConfig(baseEnv(), ['--yes']).confirmed, true);
    const custom = script.parseConfig(
      {
        ...baseEnv(),
        GCS_PREFIX: '/team/tests/',
        GCP_DATASET_PREFIX: 'x_',
        KEEP: '1',
        GCP_BQ_LOCATION: 'europe-west1',
      },
      []
    );
    assert.ok(custom.gcsRunPrefix.startsWith('team/tests/'));
    assert.ok(custom.datasetId.startsWith('x_'));
    assert.equal(custom.keep, true);
    assert.equal(custom.location, 'europe-west1');
    assert.equal(
      script.parseConfig({ ...baseEnv(), GCP_BQ_PROJECT: undefined }, ['--skip-bigquery']).skipBigQuery,
      true
    );
    assert.notEqual(script.parseConfig(baseEnv(), []).runId, script.parseConfig(baseEnv(), []).runId);
  });

  test('the report redacts secrets and masks resource names in markdown', () => {
    const lines = [];
    const report = new script.Report({ print: line => lines.push(line), secrets: ['hunter2'] });
    report.fail('S', 'check', 'failed with postgres://user:hunter2@host/db and ya29.token-value and hunter2');
    report.info('S', 'dest', 'project dest-project-1 bucket rows-bucket', '{"a":1}');
    assert.ok(!lines.join('\n').match(/hunter2|ya29\.token/));
    const markdown = report.markdown(
      ['project dest-project-1'],
      [
        ['dest-project-1', '<destination-project>'],
        ['rows-bucket', '<bucket>'],
      ]
    );
    assert.ok(!/dest-project-1|rows-bucket/.test(markdown));
    assert.match(markdown, /\*\*Result: FAIL\*\*/);
    assert.match(markdown, /<details>/);
  });
});

describe(
  'validate-reporting-gcp against in-memory doubles',
  { skip: !DATABASE_URL && 'PostgreSQL URL not set' },
  () => {
    let script;
    let sdk;
    let Pool;
    let admin;
    const leftoverSchemas = [];

    before(async () => {
      script = await import('../../scripts/validate-reporting-gcp.mjs');
      Pool = require('pg').Pool;
      sdk = {
        ledger: require('../../dist/lib/reporting/ledger/index.js'),
        bigquery: require('../../dist/lib/reporting/bigquery/index.js'),
        gcs: require('../../dist/lib/reporting/gcs/index.js'),
        createRowStorageFixture,
      };
      admin = new Pool({ connectionString: DATABASE_URL });
    });

    after(async () => {
      for (const schema of leftoverSchemas) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    });

    const schemasFor = async config =>
      (
        await admin.query(`SELECT nspname FROM pg_namespace WHERE nspname LIKE $1`, [
          `adcp_validation_${config.runId}%`,
        ])
      ).rows.map(row => row.nspname);

    const execute = async (env, argv, doubles) => {
      const config = script.parseConfig({ ...baseEnv(), CONFIRM: '1', ...env }, argv);
      const lines = [];
      const report = new script.Report({ print: line => lines.push(line) });
      await script.run(config, {
        sdk,
        Pool,
        report,
        sleep: async () => {},
        clientProject: doubles.clientProject,
        bigquery: doubles.bigquery,
        storage: doubles.storage,
      });
      return { config, report, lines };
    };
    const statusOf = (report, name) => report.entries.find(entry => entry.name === name)?.status;

    test('a full same-project run passes, reports the probes, and cleans up only what it created', async () => {
      const bigquery = createFakeBigQuery({ clientProject: 'dest-project-1' });
      const storage = createFakeStorage();
      // Neighbouring objects the run must never touch.
      const neighbour = storage.bucket('rows-bucket').file('adcp-reporting-validation-other/keep.jsonl');
      await neighbour.save(Buffer.from('keep'), { preconditionOpts: { ifGenerationMatch: 0 } });
      const sibling = storage.bucket('rows-bucket').file('adcp-reporting-validation/neighbour/keep.jsonl');
      await sibling.save(Buffer.from('keep'), { preconditionOpts: { ifGenerationMatch: 0 } });

      const { config, report } = await execute({}, [], { clientProject: 'dest-project-1', bigquery, storage });
      assert.deepEqual(
        report.failures.map(entry => `${entry.name}: ${entry.detail}`),
        []
      );
      for (const name of [
        'create temporary dataset',
        'runOnce loads every committed revision',
        'row and revision counts in BigQuery match, with no duplicates',
        'load jobs exist in the destination project and location with deterministic job IDs',
        'current_rows returns exactly one revision per obligation',
        'crash replay: no duplicate rows or revisions in BigQuery',
        'runReportingRowObjectProviderConformanceV1',
        'read the revision back from GCS, verified against the recorded digests',
      ]) {
        assert.equal(statusOf(report, name), 'PASS', name);
      }
      const placement = report.entries.find(entry => entry.name === 'where BigQuery stored labels and jobTimeoutMs');
      assert.match(placement.detail, /labels at configuration\.load\.labels/);
      assert.match(placement.detail, /jobTimeoutMs at configuration\.load\.jobTimeoutMs = "120000"/);
      assert.match(placement.block, /"jobReference"/);
      const probes = report.entries.filter(entry => /#3196/.test(entry.name));
      assert.equal(probes.length, 2);
      assert.ok(probes.every(entry => entry.status === 'INFO'));

      // Cleanup removed exactly what the run made.
      assert.deepEqual(bigquery.state.deletedDatasets, [`dest-project-1.${config.datasetId}`]);
      assert.equal(bigquery.state.datasets.size, 0);
      const remaining = [...storage.objects].filter(([, versions]) => versions.length).map(([key]) => key);
      assert.deepEqual(remaining.sort(), [
        'rows-bucket/adcp-reporting-validation-other/keep.jsonl',
        'rows-bucket/adcp-reporting-validation/neighbour/keep.jsonl',
      ]);
      assert.deepEqual(await schemasFor(config), []);
      assert.equal(statusOf(report, 'delete the GCS objects under the run prefix'), 'PASS');
      assert.equal(statusOf(report, 'delete the temporary BigQuery dataset'), 'PASS');
    });

    test('a cross-project run completes and cleans up; any failure is the known replay-lookup gap', async () => {
      const bigquery = createFakeBigQuery({ clientProject: 'client-project-1' });
      const { config, report } = await execute({ GCP_CLIENT_PROJECT: 'client-project-1' }, ['--skip-gcs'], {
        clientProject: 'client-project-1',
        bigquery,
        storage: createFakeStorage(),
      });
      // Before PR #3197 the replay status check ignores the destination project, which the
      // crash-replay check is there to catch. Everything else must pass either way.
      assert.deepEqual(
        report.failures.filter(entry => !/^crash replay/.test(entry.name)).map(entry => entry.name),
        []
      );
      assert.equal(
        statusOf(report, 'load jobs exist in the destination project and location with deterministic job IDs'),
        'PASS'
      );
      assert.ok(
        report.entries.some(entry => entry.name === 'the same job looked up through the client default project')
      );
      assert.deepEqual(bigquery.state.deletedDatasets, [`dest-project-1.${config.datasetId}`]);
      assert.deepEqual(await schemasFor(config), []);
    });

    test('jobs created outside the destination project are reported as a failure', async () => {
      const bigquery = createFakeBigQuery({ clientProject: 'client-project-1', jobProject: 'client' });
      const { config, report } = await execute({ GCP_CLIENT_PROJECT: 'client-project-1' }, ['--skip-gcs'], {
        clientProject: 'client-project-1',
        bigquery,
        storage: createFakeStorage(),
      });
      assert.equal(
        statusOf(report, 'load jobs exist in the destination project and location with deterministic job IDs'),
        'FAIL'
      );
      assert.deepEqual(bigquery.state.deletedDatasets, [`dest-project-1.${config.datasetId}`]);
    });

    test('--skip-gcs and --skip-bigquery leave the other service untouched', async () => {
      const bigquery = createFakeBigQuery({ clientProject: 'dest-project-1' });
      const storage = createFakeStorage();
      const onlyGcs = await execute({}, ['--skip-bigquery'], { clientProject: 'dest-project-1', bigquery, storage });
      assert.deepEqual(onlyGcs.report.failures, []);
      assert.equal(bigquery.state.queries.length, 0);
      assert.equal(bigquery.state.datasets.size, 0);
      assert.ok(onlyGcs.report.entries.some(entry => entry.section === 'GCS row provider'));
      assert.ok(!onlyGcs.report.entries.some(entry => entry.section === 'BigQuery sink'));

      const onlyBigQuery = await execute({}, ['--skip-gcs'], { clientProject: 'dest-project-1', bigquery, storage });
      assert.deepEqual(onlyBigQuery.report.failures, []);
      assert.ok(!onlyBigQuery.report.entries.some(entry => entry.section === 'GCS row provider'));
    });

    test('KEEP=1 leaves the dataset, objects and schemas in place and says how to remove them', async () => {
      const bigquery = createFakeBigQuery({ clientProject: 'dest-project-1' });
      const storage = createFakeStorage();
      const { config, report } = await execute({ KEEP: '1' }, [], {
        clientProject: 'dest-project-1',
        bigquery,
        storage,
      });
      assert.deepEqual(report.failures, []);
      assert.deepEqual(bigquery.state.deletedDatasets, []);
      assert.equal(bigquery.state.datasets.size, 1);
      assert.ok([...storage.objects.keys()].some(key => key.startsWith(`rows-bucket/${config.gcsRunPrefix}/`)));
      const schemas = await schemasFor(config);
      assert.ok(schemas.length > 0);
      leftoverSchemas.push(...schemas);
      const kept = report.entries.find(entry => entry.name === 'KEEP=1: nothing was deleted');
      assert.match(kept.detail, /bq rm -r -f -d dest-project-1:/);
      assert.match(kept.detail, /gcloud storage rm -r gs:\/\/rows-bucket\//);
    });

    test('an unsafe bucket fails the probe and conformance, and cleanup still runs', async () => {
      const storage = createFakeStorage({
        bucketMetadata: {
          iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced' },
          lifecycle: { rule: [{ action: { type: 'Delete' }, condition: { age: 1 } }] },
        },
      });
      const { config, report } = await execute({}, ['--skip-bigquery'], { clientProject: 'dest-project-1', storage });
      assert.equal(
        statusOf(report, 'provider probe: uniform bucket-level access, public access prevention, lifecycle rules'),
        'FAIL'
      );
      assert.equal(statusOf(report, 'runReportingRowObjectProviderConformanceV1'), 'FAIL');
      assert.match(
        report.entries.find(entry => entry.name === 'runReportingRowObjectProviderConformanceV1').detail,
        /lifecycle rule can delete live row objects/
      );
      assert.deepEqual(await schemasFor(config), []);
    });

    test('a failed dataset creation stops the BigQuery section and never deletes a dataset', async () => {
      const bigquery = createFakeBigQuery({ clientProject: 'dest-project-1' });
      bigquery.dataset = () => ({
        async create() {
          throw Object.assign(new Error('Access Denied: bigquery.datasets.create'), { code: 403 });
        },
        async delete() {
          throw new Error('delete must not be called');
        },
      });
      const { report } = await execute({}, ['--skip-gcs'], {
        clientProject: 'dest-project-1',
        bigquery,
        storage: createFakeStorage(),
      });
      assert.equal(statusOf(report, 'create temporary dataset'), 'FAIL');
      assert.match(report.failures[0].detail, /Access Denied/);
      assert.equal(report.failures.length, 1);
      assert.ok(!report.entries.some(entry => /delete the temporary BigQuery dataset/.test(entry.name)));
    });
  }
);
