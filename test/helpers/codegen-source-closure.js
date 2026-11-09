/**
 * Shared harness and fixtures for the Zod generator's source-closure tests.
 *
 * The post-processors read `additionalProperties` from the synced schema
 * cache. These tests inject a reader over inline fixtures instead, so they
 * never depend on whichever bundle is in `schemas/cache/latest`.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '../..');
const GENERATE_ZOD_PATH = path.join(REPO_ROOT, 'scripts/generate-zod-from-ts.ts');

/**
 * Run `body` (TypeScript, the body of an async function) in a tsx harness that
 * can see `__test__`, `data`, `reader(sources)`, `attempt(fn)` and
 * `load(name, source)`. `load` writes a module next to the harness (with `z`
 * imported) and returns its exports, so emitted Zod can be exercised at
 * runtime. Returns the JSON-serializable value `body` returns.
 */
function runHarness(body, data = {}) {
  // Inside the repo so `zod` resolves from the emitted modules.
  fs.mkdirSync(path.join(REPO_ROOT, '.context'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(REPO_ROOT, '.context/source-closure-'));
  try {
    fs.writeFileSync(path.join(directory, 'data.json'), JSON.stringify(data));
    fs.writeFileSync(
      path.join(directory, 'harness.ts'),
      `
import { readFileSync, writeFileSync } from 'node:fs';
import { __test__ } from ${JSON.stringify(GENERATE_ZOD_PATH)};

const data = JSON.parse(readFileSync(new URL('./data.json', import.meta.url), 'utf8'));
const reader = (sources: Record<string, unknown>) => (file: string, pointer = '') => {
  const key = file + '#' + pointer;
  if (!(key in sources)) throw new Error('no fixture for ' + key);
  return structuredClone(sources[key]) as Record<string, unknown>;
};
const attempt = (fn: () => unknown) => {
  try {
    return { value: fn() };
  } catch (error) {
    return { error: (error as Error).message };
  }
};
const load = async (name: string, source: string) => {
  writeFileSync(new URL('./' + name + '.ts', import.meta.url), "import { z } from 'zod';\\n" + source);
  return import('./' + name);
};
async function main() {
  const result = await (async () => {
${body}
  })();
  writeFileSync(new URL('./out.json', import.meta.url), JSON.stringify(result ?? null));
}
main().catch(error => {
  console.error(error);
  process.exit(1);
});
`
    );
    const result = spawnSync('npx', ['tsx', path.join(directory, 'harness.ts')], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`harness failed (${result.status}): ${result.stderr}\n${result.stdout}`);
    }
    return JSON.parse(fs.readFileSync(path.join(directory, 'out.json'), 'utf8'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** The 14 reporting evidence schemas: [export name, source file, JSON pointer]. */
const EVIDENCE_SOURCES = [
  ['ReportingCoverage', 'core/reporting-coverage.json', ''],
  ['ReportingStatusIssue', 'core/reporting-status-issue.json', ''],
  ['ReportingCanonicalContentDigest', 'core/reporting-canonical-content-digest.json', ''],
  ['IntegerReportingControlTotal', 'core/reporting-control-total.json', '/oneOf/0'],
  ['DecimalReportingControlTotal', 'core/reporting-control-total.json', '/oneOf/1'],
  ['SHA256PhysicalChecksum', 'core/reporting-verification.json', '/properties/physical_checksums/items/oneOf/0'],
  ['SHA512PhysicalChecksum', 'core/reporting-verification.json', '/properties/physical_checksums/items/oneOf/1'],
  ['ReportingResource', 'core/reporting-resource.json', ''],
  ['ReportingVerification', 'core/reporting-verification.json', ''],
  ['ReportingSchedule', 'core/reporting-schedule.json', ''],
  ['ReportingReceipt', 'core/reporting-receipt.json', ''],
  ['ReportingRevision', 'core/reporting-revision.json', ''],
  ['ReportingObligation', 'core/reporting-obligation.json', ''],
  ['ReportingMaterialization', 'core/reporting-materialization.json', ''],
];

/**
 * Source fixtures keyed `file#pointer` for the evidence schemas. `overrides`
 * maps an export name to a partial schema merged over the default.
 */
function evidenceSources(closed, overrides = {}) {
  const sources = {};
  for (const [name, file, pointer] of EVIDENCE_SOURCES) {
    const nested = closed ? { type: 'object', additionalProperties: false } : { type: 'object' };
    sources[`${file}#${pointer}`] = {
      title: name,
      type: 'object',
      ...(closed ? { additionalProperties: false } : {}),
      properties: { nested },
      ...overrides[name],
    };
  }
  return sources;
}

/** The generated text of one schema export: from its `export const` to the next one. */
function schemaBlock(content, name) {
  const start = content.indexOf(`export const ${name} = `);
  if (start < 0) throw new Error(`${name} is not in the output`);
  const end = content.indexOf('\n\nexport const ', start + 1);
  return end < 0 ? content.slice(start) : content.slice(start, end);
}

module.exports = { REPO_ROOT, runHarness, EVIDENCE_SOURCES, evidenceSources, schemaBlock };
