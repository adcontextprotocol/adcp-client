/**
 * In-memory fake of the official `@google-cloud/bigquery` surface used by the
 * reporting warehouse sink and scripts/validate-reporting-gcp.mjs:
 * dataset().create/delete/table().load, job().getMetadata and query().
 *
 * Like BigQuery it enforces job-ID uniqueness per project, refuses loads into
 * tables that do not exist, and looks jobs up in the project the caller names
 * (the client's default project when none is given). Loaded job metadata
 * mirrors @google-cloud/bigquery 9.2.0, which places every load option,
 * including `labels` and `jobTimeoutMs`, inside `configuration.load`.
 *
 * `query()` understands only the DDL and SELECT shapes the validation script
 * issues; anything else throws, so drift is loud.
 */
const { readFileSync } = require('node:fs');

function apiError(code, message) {
  return Object.assign(new Error(message), { code });
}

function createFakeBigQuery({ clientProject = 'client-project', jobProject = 'destination' } = {}) {
  const state = {
    datasets: new Map(), // `${project}.${dataset}` -> { labels, location }
    tables: new Map(), // `${project}.${dataset}.${table}` -> row objects
    views: new Map(), // view key -> { rows, revisions } table keys
    jobs: new Map(), // `${project}/${jobId}` -> job resource
    deletedDatasets: [],
    queries: [],
  };

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
        return {
          async load(file, metadata) {
            const tableKey = `${key}.${tableId}`;
            if (!state.datasets.has(key)) throw apiError(404, `Not found: Dataset ${key}`);
            if (!state.tables.has(tableKey)) throw apiError(404, `Not found: Table ${tableKey}`);
            const owner = jobProject === 'client' ? clientProject : project;
            const jobKey = `${owner}/${metadata.jobId}`;
            if (state.jobs.has(jobKey)) throw apiError(409, `Already Exists: Job ${jobKey}`);
            const lines = readFileSync(file, 'utf8')
              .split('\n')
              .filter(Boolean)
              .map(line => JSON.parse(line));
            state.tables.get(tableKey).push(...lines);
            const { jobId, ...load } = metadata;
            const resource = {
              jobReference: { projectId: owner, jobId, location: options.location },
              status: { state: 'DONE' },
              configuration: {
                load: { destinationTable: { projectId: project, datasetId, tableId }, ...load },
              },
              statistics: { load: { outputRows: String(lines.length) } },
            };
            state.jobs.set(jobKey, resource);
            return [resource];
          },
        };
      },
    };
  }

  function job(jobId, options = {}) {
    return {
      async getMetadata() {
        const resource = state.jobs.get(`${options.projectId ?? clientProject}/${jobId}`);
        if (!resource) throw apiError(404, `Not found: Job ${options.projectId ?? clientProject}:${jobId}`);
        return [resource];
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

    if (/COUNT\(DISTINCT CONCAT\(reporting_revision_id/.test(sql)) {
      const rows = rowsOf(tableIn(sql));
      const distinct = new Set(rows.map(row => `${row.reporting_revision_id}:${row.ordinal}`));
      return [[{ n: rows.length, distinct_n: distinct.size }]];
    }
    if (/COUNT\(DISTINCT reporting_revision_id\) AS distinct_n/.test(sql)) {
      const rows = rowsOf(tableIn(sql));
      return [[{ n: rows.length, distinct_n: new Set(rows.map(row => row.reporting_revision_id)).size }]];
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

  return { state, dataset, job, query };
}

module.exports = { createFakeBigQuery };
