const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv').default;
const addFormats = require('ajv-formats').default;

const ROOT = path.resolve(__dirname, '..');
const source = require('./fixtures/reporting-consumer-status/canonical-rc3.json');
const digest = 'a'.repeat(64);
const base = {
  reporting_status_id: 'reporting-status-0001',
  delivery_config_id: 'config-1',
  delivery_config_version: 1,
  report_definition_id: 'report-1',
  period: { start: '2026-09-01T00:00:00Z', end: '2026-09-02T00:00:00Z', source_timezone: 'UTC' },
  status_as_of: '2026-09-03T00:00:00Z',
};
const evidence = {
  received: {
    reporting_obligation_id: 'obligation-1',
    reporting_revision_id: 'revision-1',
    observed_revision_content_sha256: digest,
  },
  obligation_missing: {},
  revision_missing: { reporting_obligation_id: 'obligation-1' },
  unreadable: {
    reporting_obligation_id: 'obligation-1',
    reporting_revision_id: 'revision-1',
    failure_code: 'integrity_mismatch',
  },
  content_mismatch: {
    reporting_obligation_id: 'obligation-1',
    reporting_revision_id: 'revision-1',
    observed_revision_content_sha256: digest,
    mismatch_code: 'metric_missing',
  },
};
const cases = [];
const add = (name, value, valid) => cases.push({ name, value, valid });
for (const consumer_status of source.properties.consumer_status.enum) {
  const valid = { ...base, consumer_status, ...evidence[consumer_status] };
  add(consumer_status, valid, true);
  const rule = source.allOf.find(arm => arm.if?.properties?.consumer_status?.const === consumer_status).then;
  for (const field of rule.required ?? []) {
    const value = { ...valid };
    delete value[field];
    add(`${consumer_status}: missing ${field}`, value, false);
  }
  const forbidden = rule.not.anyOf?.flatMap(arm => arm.required) ?? rule.not.required;
  for (const field of forbidden) {
    const value = source.properties[field].enum?.[0] ?? (field.includes('sha256') ? digest : 'forbidden-1');
    add(`${consumer_status}: forbidden ${field}`, { ...valid, [field]: value }, false);
  }
}
const mismatch = { ...base, consumer_status: 'content_mismatch', ...evidence.content_mismatch };
for (const mismatch_code of source.properties.mismatch_code.enum) {
  add(`code: ${mismatch_code}`, { ...mismatch, mismatch_code }, true);
}
for (const mismatch_code of ['', 'measurement_disagreement', 'integrity_mismatch', null, 1]) {
  add(`invalid code: ${mismatch_code}`, { ...mismatch, mismatch_code }, false);
}
for (const observed_revision_content_sha256 of ['', 'a'.repeat(63), 'g'.repeat(64), null]) {
  add(`invalid digest: ${observed_revision_content_sha256}`, { ...mismatch, observed_revision_content_sha256 }, false);
}
add('uppercase digest', { ...mismatch, observed_revision_content_sha256: digest.toUpperCase() }, true);
add(
  'paired snapshot',
  { ...mismatch, seller_ledger_snapshot_id: 'snapshot-1', seller_ledger_as_of: base.status_as_of },
  true
);
add('snapshot without time', { ...mismatch, seller_ledger_snapshot_id: 'snapshot-1' }, false);
add('time without snapshot', { ...mismatch, seller_ledger_as_of: base.status_as_of }, false);
add('closed fields', { ...mismatch, unexpected: true }, false);

test('canonical content_mismatch constraints survive TypeScript -> Zod generation and roundtrip', () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(source);
  for (const entry of cases) assert.equal(validate(entry.value), entry.valid, entry.name);

  // Use the real TS and Zod generators on the immutable forward schema. The
  // primary SDK pin can remain rc.2 while this regression always runs.
  fs.mkdirSync(path.join(ROOT, '.context'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(ROOT, '.context/consumer-status-codegen-'));
  try {
    fs.writeFileSync(path.join(directory, 'cases.json'), JSON.stringify(cases));
    fs.writeFileSync(path.join(directory, 'source.json'), JSON.stringify(source));
    fs.writeFileSync(
      path.join(directory, 'harness.ts'),
      `
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { compile } from 'json-schema-to-typescript';
import { generate } from 'ts-to-zod';
import { __test__ } from '../../scripts/generate-zod-from-ts';
import { injectJsdocConstraints } from '../../scripts/schema-utils';
async function main() {
  const source = JSON.parse(readFileSync(new URL('./source.json', import.meta.url), 'utf8'));
  // The production TypeScript projection flattens the conditional allOf arms.
  const { allOf, ...flat } = source;
  const types = await compile(injectJsdocConstraints(flat), 'ReportingConsumerStatus', { bannerComment: '' });
  const declarations = types + '\\nexport interface SyncReportingStatusRequest { statuses: ReportingConsumerStatus[]; }\\nexport interface SyncReportingStatusResponse { status: "completed"; results: ({ result: "recorded" | "unchanged"; consumer_status: ReportingConsumerStatus } | { result: "failed"; errors: unknown[] })[]; }';
  const generated = generate({ sourceText: declarations, getSchemaName: name => name + 'Schema' }).getZodSchemasFile('./types');
  const passthrough = __test__.postProcessForPassthrough(generated);
  for (const mutate of [
    schema => { schema.allOf[0].else = { not: { required: ['consumer_commit_ref'] } }; },
    schema => { schema.allOf.push({ if: { required: ['mismatch_code'] }, then: { required: ['consumer_commit_ref'] } }); },
    schema => { schema.allOf[0].then.not = { required: ['failure_code', 'mismatch_code'] }; },
    schema => { schema.allOf[0].then.not = { anyOf: [{ type: 'object' }] }; },
    schema => { schema.allOf.pop(); },
  ]) {
    const changed = structuredClone(source);
    mutate(changed);
    assert.throws(() => __test__.postProcessReportingConsumerStatusConstraints(passthrough, changed), /consumer-status|Consumer-status/);
  }
  const refined = __test__.postProcessReportingConsumerStatusConstraints(passthrough, source);
  writeFileSync(new URL('./generated.ts', import.meta.url), refined);
  const { ReportingConsumerStatusSchema: schema, SyncReportingStatusRequestSchema: request, SyncReportingStatusResponseSchema: response } = await import('./generated');
  const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));
  // JS consumers can widen the discriminant through the public composition
  // method. Unknown names must reject without looking up Object.prototype.
  const widened = schema.safeExtend({ consumer_status: z.string() });
  for (const consumer_status of ['toString', 'constructor', '__proto__', 'bogus']) {
    assert.equal(widened.safeParse({ ...cases[0].value, consumer_status }).success, false);
  }
  const outcomes = cases.map(entry => {
    const parsed = schema.safeParse(entry.value);
    return {
      valid: parsed.success,
      roundtrip: parsed.success ? parsed.data : undefined,
      extended: schema.extend({}).safeParse(entry.value).success,
      safeExtended: schema.safeExtend({}).safeParse(entry.value).success,
      request: request.safeParse({ statuses: [entry.value] }).success,
      recorded: response.safeParse({ status: 'completed', results: [{ result: 'recorded', consumer_status: { ...entry.value, recorded_at: '2026-09-03T00:00:01Z' } }] }).success,
      unchanged: response.safeParse({ status: 'completed', results: [{ result: 'unchanged', consumer_status: { ...entry.value, recorded_at: '2026-09-03T00:00:01Z' } }] }).success,
    };
  });
  writeFileSync(new URL('./out.json', import.meta.url), JSON.stringify(outcomes));
}
main();
`
    );
    const result = spawnSync('npx', ['tsx', path.join(directory, 'harness.ts')], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const outcomes = JSON.parse(fs.readFileSync(path.join(directory, 'out.json'), 'utf8'));
    for (const [index, entry] of cases.entries()) {
      const outcome = outcomes[index];
      for (const field of ['valid', 'extended', 'safeExtended', 'request', 'recorded', 'unchanged']) {
        assert.equal(outcome[field], entry.valid, `${entry.name}: ${field}`);
      }
      if (entry.valid) assert.deepEqual(outcome.roundtrip, entry.value, `${entry.name}: retained fields`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
