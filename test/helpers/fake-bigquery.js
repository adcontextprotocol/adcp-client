/**
 * In-memory fake of the official `@google-cloud/bigquery` surface used by the
 * reporting warehouse sink and scripts/validate-reporting-gcp.mjs:
 * dataset().create/delete, table().load/createLoadJob, job().getMetadata/cancel and query().
 *
 * Like BigQuery it enforces job-ID uniqueness per project, refuses loads into
 * tables that do not exist, and looks jobs up in the project the caller names
 * (the client's default project when none is given).
 *
 * Job placement mirrors @google-cloud/bigquery 9.2.0 and the real service.
 * For a local-file load the client puts every load option, including `labels`
 * and `jobTimeoutMs`, inside `configuration.load`, and there is no way to set
 * `configuration.labels` or `configuration.jobTimeoutMs`. BigQuery defines
 * those two at `configuration.*` only, so it silently drops them from
 * `configuration.load`. The fake does the same and records the drop in
 * `state.droppedLoadFields`, so a sink that relies on them is caught offline.
 * `state.loadOptions` records the options each load call carried.
 *
 * `job().cancel()` is recorded in `state.cancels` (project and location as
 * addressed) and, like BigQuery, answers 404 for a job it does not know.
 *
 * `uploadMs` (milliseconds, or `tableId => milliseconds`) delays every submission before the job is
 * created or a duplicate job ID is refused with 409, as the upload does for a local-file load.
 *
 * With `loadDurationMs` (milliseconds, or `tableId => milliseconds`), a load job stays RUNNING for that long before its rows
 * land and `load()` resolves. A cancel that reaches a running job stops it the
 * way BigQuery does: DONE with an `errorResult` whose reason is `stopped`, no
 * rows appended, and the pending `load()` rejected.
 *
 * `query()` understands only the DDL and SELECT shapes the validation script
 * issues; anything else throws, so drift is loud.
 */
const { readFileSync } = require('node:fs');

function apiError(code, message) {
  return Object.assign(new Error(message), { code });
}

// `transformLoadedLine(tableId, line)` models a service-side fault: it may rewrite each loaded line.
function createFakeBigQuery({
  clientProject = 'client-project',
  jobProject = 'destination',
  transformLoadedLine,
  loadDurationMs = 0,
  uploadMs = 0,
} = {}) {
  const state = {
    datasets: new Map(), // `${project}.${dataset}` -> { labels, location }
    tables: new Map(), // `${project}.${dataset}.${table}` -> row objects
    views: new Map(), // view key -> { rows, revisions } table keys
    jobs: new Map(), // `${project}/${jobId}` -> job resource
    deletedDatasets: [],
    queries: [],
    loadOptions: [], // { tableId, options } for every load call
    droppedLoadFields: [], // { jobId, fields } the service ignored inside configuration.load
    cancels: [], // { jobId, projectId, location } for every job().cancel()
  };
  // Fields BigQuery defines on JobConfiguration, not on JobConfigurationLoad.
  const JOB_LEVEL_FIELDS = ['labels', 'jobTimeoutMs'];

  const keyOf = (project, datasetId) => `${project}.${datasetId}`;

  function dataset(datasetId, options = {}) {
    const project = options.projectId ?? clientProject;
    const key = keyOf(project, datasetId);
    return {
      projectId: project,
      async create(createOptions = {}) {
        if (state.datasets.has(key)) throw apiError(409, `Already Exists: Dataset ${key}`);
        state.datasets.set(key, { labels: createOptions.labels, location: options.location, createOptions });
        return [{ id: datasetId }, {}];
      },
      async delete(deleteOptions = {}) {
        if (!state.datasets.has(key)) throw apiError(404, `Not found: Dataset ${key}`);
        if (!deleteOptions.force) throw apiError(400, 'dataset is not empty');
        for (const tableKey of [...state.tables.keys()])
          if (tableKey.startsWith(`${key}.`)) state.tables.delete(tableKey);
        for (const viewKey of [...state.views.keys()]) if (viewKey.startsWith(`${key}.`)) state.views.delete(viewKey);
        state.datasets.delete(key);
        state.deletedDatasets.push(key);
        return [{}];
      },
      table(tableId) {
        // Upload, then create the job (or refuse a duplicate ID, which BigQuery also does only
        // after the upload). Resolves to the promise that settles when the job finishes.
        async function submit(file, metadata) {
          // The client opens the file when the call starts, so the caller may delete it mid-upload.
          const contents = readFileSync(file, 'utf8');
          const upload = typeof uploadMs === 'function' ? uploadMs(tableId) : uploadMs;
          if (upload) await new Promise(resolve => setTimeout(resolve, upload));
          const tableKey = `${key}.${tableId}`;
          if (!state.datasets.has(key)) throw apiError(404, `Not found: Dataset ${key}`);
          if (!state.tables.has(tableKey)) throw apiError(404, `Not found: Table ${tableKey}`);
          const owner = jobProject === 'client' ? clientProject : project;
          const jobKey = `${owner}/${metadata.jobId}`;
          state.loadOptions.push({ tableId, options: structuredClone(metadata) });
          if (state.jobs.has(jobKey)) throw apiError(409, `Already Exists: Job ${jobKey}`);
          const lines = contents
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line))
            .map(line => (transformLoadedLine ? transformLoadedLine(tableId, line) : line));
          const { jobId, ...load } = metadata;
          const dropped = JOB_LEVEL_FIELDS.filter(field => field in load);
          for (const field of dropped) delete load[field];
          if (dropped.length) state.droppedLoadFields.push({ jobId, fields: dropped });
          const resource = {
            jobReference: { projectId: owner, jobId, location: options.location },
            status: { state: 'DONE' },
            configuration: {
              load: { destinationTable: { projectId: project, datasetId, tableId }, ...load },
            },
            statistics: { load: { outputRows: String(lines.length) } },
            _lines: lines,
            _tableKey: tableKey,
          };
          const duration = typeof loadDurationMs === 'function' ? loadDurationMs(tableId) : loadDurationMs;
          if (duration) resource.status = { state: 'RUNNING' };
          state.jobs.set(jobKey, resource);
          if (!duration) {
            state.tables.get(tableKey).push(...lines);
            return { finished: Promise.resolve([publicJob(resource)]) };
          }
          const finished = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              resource._stop = undefined;
              resource.status = { state: 'DONE' };
              state.tables.get(tableKey).push(...lines);
              resolve([publicJob(resource)]);
            }, duration);
            resource._stop = () => {
              clearTimeout(timer);
              resource._stop = undefined;
              const errorResult = {
                reason: 'stopped',
                message: 'Job execution was cancelled: User requested cancellation',
              };
              resource.status = { state: 'DONE', errorResult, errors: [errorResult] };
              reject(Object.assign(new Error(errorResult.message), { errors: [errorResult] }));
            };
          });
          return { finished };
        }
        return {
          async load(file, metadata) {
            return (await submit(file, metadata)).finished;
          },
          // Resolves once the job exists; `promise()` settles when it finishes, like the client's Job.
          async createLoadJob(file, metadata) {
            const { finished } = await submit(file, metadata);
            finished.catch(() => {});
            return [{ id: metadata.jobId, promise: () => finished }, {}];
          },
        };
      },
    };
  }

  // Resources hold their pending rows privately; callers see the REST shape only.
  const publicJob = ({ _lines, _tableKey, _stop, ...resource }) => structuredClone(resource);

  function job(jobId, options = {}) {
    const project = options.projectId ?? clientProject;
    return {
      async getMetadata() {
        const resource = state.jobs.get(`${project}/${jobId}`);
        if (!resource) throw apiError(404, `Not found: Job ${project}:${jobId}`);
        return [publicJob(resource)];
      },
      async cancel() {
        state.cancels.push({ jobId, projectId: options.projectId, location: options.location });
        const resource = state.jobs.get(`${project}/${jobId}`);
        if (!resource) throw apiError(404, `Not found: Job ${project}:${jobId}`);
        // Like BigQuery, the response shows the job as it was when the cancel was accepted.
        const response = { kind: 'bigquery#jobCancelResponse', job: publicJob(resource) };
        resource._stop?.();
        return [response];
      },
    };
  }

  const tableIn = sql => {
    const match = /FROM `([^`]+)`/.exec(sql);
    if (!match) throw new Error(`fake BigQuery cannot find a table in: ${sql}`);
    return match[1];
  };
  const rowsOf = tableKey => {
    if (!state.tables.has(tableKey)) throw apiError(404, `Not found: Table ${tableKey}`);
    return state.tables.get(tableKey);
  };

  async function query({ query: sql, location }) {
    state.queries.push({ sql, location });
    let handled = false;
    for (const match of sql.matchAll(/CREATE TABLE IF NOT EXISTS `([^`]+)`/g)) {
      handled = true;
      const datasetKey = match[1].split('.').slice(0, 2).join('.');
      if (!state.datasets.has(datasetKey)) throw apiError(404, `Not found: Dataset ${datasetKey}`);
      if (!state.tables.has(match[1])) state.tables.set(match[1], []);
    }
    const view = /CREATE OR REPLACE VIEW `([^`]+)` AS[\s\S]*?FROM `([^`]+)` AS row_data[\s\S]*?FROM `([^`]+)`/.exec(
      sql
    );
    if (view) {
      handled = true;
      state.views.set(view[1], { rows: view[2], revisions: view[3] });
    }
    if (handled) return [[]];

    if (/SELECT DISTINCT reporting_obligation_id, CAST\(period_date AS STRING\) AS period_date/.test(sql)) {
      // One row per distinct (obligation, date) pair, like SELECT DISTINCT, so a split date shows twice.
      const pairs = new Map();
      for (const row of rowsOf(tableIn(sql))) {
        pairs.set(JSON.stringify([row.reporting_obligation_id, row.period_date]), {
          reporting_obligation_id: row.reporting_obligation_id,
          period_date: row.period_date,
        });
      }
      return [[...pairs.values()]];
    }
    if (/COUNT\(DISTINCT CONCAT\(reporting_revision_id/.test(sql)) {
      const rows = rowsOf(tableIn(sql));
      const distinct = new Set(rows.map(row => `${row.reporting_revision_id}:${row.ordinal}`));
      return [[{ n: rows.length, distinct_n: distinct.size }]];
    }
    if (/COUNT\(DISTINCT reporting_revision_id\) AS distinct_n/.test(sql)) {
      const rows = rowsOf(tableIn(sql));
      return [[{ n: rows.length, distinct_n: new Set(rows.map(row => row.reporting_revision_id)).size }]];
    }
    if (/^SELECT COUNT\(\*\) AS n FROM `[^`]+`$/.test(sql)) {
      return [[{ n: rowsOf(tableIn(sql)).length }]];
    }
    if (/SUM\(CAST\(JSON_VALUE\(/.test(sql)) {
      return [[{ total: rowsOf(tableIn(sql)).reduce((sum, row) => sum + Number(row.row?.impressions ?? 0), 0) }]];
    }
    if (/GROUP BY reporting_obligation_id/.test(sql)) {
      const definition = state.views.get(tableIn(sql));
      if (!definition) throw apiError(404, `Not found: Table ${tableIn(sql)}`);
      const revisions = rowsOf(definition.revisions);
      const current = new Map();
      for (const revision of revisions) {
        const best = current.get(revision.reporting_obligation_id);
        if (!best || revision.revision_number > best.revision_number) {
          current.set(revision.reporting_obligation_id, revision);
        }
      }
      const result = [];
      for (const [obligationId, revision] of current) {
        const rows = rowsOf(definition.rows).filter(
          row =>
            row.reporting_obligation_id === obligationId && row.reporting_revision_id === revision.reporting_revision_id
        );
        result.push({
          reporting_obligation_id: obligationId,
          revision_count: new Set(rows.map(row => row.reporting_revision_id)).size,
          reporting_revision_id: revision.reporting_revision_id,
          n: rows.length,
        });
      }
      return [result.sort((a, b) => (a.reporting_obligation_id < b.reporting_obligation_id ? -1 : 1))];
    }
    throw new Error(`fake BigQuery does not understand: ${sql.slice(0, 120)}`);
  }

  return {
    state,
    dataset,
    job,
    query,
  };
}

module.exports = { createFakeBigQuery };
