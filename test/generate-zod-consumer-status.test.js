const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const RefParser = require('@apidevtools/json-schema-ref-parser').default;
const Ajv = require('ajv').default;
const addFormats = require('ajv-formats').default;

const ROOT = path.resolve(__dirname, '..');
const GENERATED = path.join(ROOT, 'src/lib/types/schemas.generated.ts');
const SCHEMAS = {
  status: path.join(ROOT, 'schemas/cache/latest/core/reporting-consumer-status.json'),
  request: path.join(ROOT, 'schemas/cache/latest/bundled/media-buy/sync-reporting-status-request.json'),
  response: path.join(ROOT, 'schemas/cache/latest/bundled/media-buy/sync-reporting-status-response.json'),
};
const digest = 'bcd079902f3c8edb4315dbbdaf9b4e37f6fd5af33c80d1fe6ac8c655581342d4';
const period = {
  start: '2026-03-08T05:00:00Z',
  end: '2026-03-09T04:00:00Z',
  source_timezone: 'America/New_York',
};

function status(consumer_status, overrides = {}) {
  const evidence = {
    received: {
      reporting_obligation_id: 'obligation-portable-0001',
      reporting_revision_id: 'revision-portable-0001',
      observed_revision_content_sha256: digest,
    },
    obligation_missing: {},
    revision_missing: { reporting_obligation_id: 'obligation-portable-0001' },
    unreadable: {
      reporting_obligation_id: 'obligation-portable-0001',
      reporting_revision_id: 'revision-portable-0001',
      failure_code: 'integrity_mismatch',
    },
  }[consumer_status];
  return {
    reporting_status_id: `portable-${consumer_status.replace('_', '-')}-0001`,
    delivery_config_id: 'portable-calendar-daily',
    delivery_config_version: 1,
    report_definition_id: 'portable-delivery-v1',
    period,
    ...evidence,
    consumer_status,
    status_as_of: '2026-03-09T05:00:00Z',
    ...overrides,
  };
}

function request(item) {
  return {
    account: { account_id: 'portable-account-0001' },
    idempotency_key: 'portable-status-batch-0001',
    statuses: [item],
  };
}

function response(result) {
  return { adcp_version: '3.2-rc.2', adcp_major_version: 3, status: 'completed', results: [result] };
}

const validStatuses = ['received', 'obligation_missing', 'revision_missing', 'unreadable'].map(value => status(value));
const cases = [
  ...validStatuses.map((value, index) => ({ id: `valid-status-${index}`, schema: 'status', value, expected: true })),
  {
    id: 'received-missing-evidence',
    schema: 'status',
    value: status('received', {
      reporting_obligation_id: undefined,
      reporting_revision_id: undefined,
      observed_revision_content_sha256: undefined,
    }),
    expected: false,
  },
  { id: 'closed-status', schema: 'status', value: status('obligation_missing', { unexpected: true }), expected: false },
  {
    id: 'closed-period',
    schema: 'status',
    value: status('obligation_missing', { period: { ...period, unexpected: true } }),
    expected: false,
  },
  { id: 'valid-request', schema: 'request', value: request(validStatuses[0]), expected: true },
  {
    id: 'caller-recorded-at',
    schema: 'request',
    value: request(status('received', { recorded_at: '2026-03-09T05:00:01Z' })),
    expected: false,
  },
  { id: 'empty-statuses', schema: 'request', value: { ...request(validStatuses[0]), statuses: [] }, expected: false },
  {
    id: 'valid-recorded',
    schema: 'response',
    value: response({
      result: 'recorded',
      consumer_status: { ...validStatuses[0], recorded_at: '2026-03-09T05:00:01Z' },
    }),
    expected: true,
  },
  {
    id: 'valid-unchanged',
    schema: 'response',
    value: response({
      result: 'unchanged',
      consumer_status: { ...validStatuses[0], recorded_at: '2026-03-09T05:00:01Z' },
    }),
    expected: true,
  },
  {
    id: 'recorded-missing-recorded-at',
    schema: 'response',
    value: response({ result: 'recorded', consumer_status: validStatuses[0] }),
    expected: false,
  },
  {
    id: 'failed-empty-errors',
    schema: 'response',
    value: response({ result: 'failed', reporting_status_id: 'portable-failed-status-0001', errors: [] }),
    expected: false,
  },
  {
    id: 'empty-results',
    schema: 'response',
    value: {
      ...response({
        result: 'failed',
        reporting_status_id: 'portable-failed-status-0001',
        errors: [{ code: 'VALIDATION_ERROR', message: 'invalid' }],
      }),
      results: [],
    },
    expected: false,
  },
];

function removeNestedIds(value, root = true, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (!Array.isArray(value) && !root) delete value.$id;
  Object.values(value).forEach(child => removeNestedIds(child, false, seen));
}

async function authoritativeOutcomes() {
  const validators = {};
  for (const [name, schemaPath] of Object.entries(SCHEMAS)) {
    const source = await RefParser.dereference(schemaPath);
    removeNestedIds(source);
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    validators[name] = ajv.compile(source);
  }
  return cases.map(entry => validators[entry.schema](entry.value));
}

function generatedOutcomes() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '.zod-consumer-status-'));
  const inputPath = path.join(directory, 'cases.json');
  const outputPath = path.join(directory, 'out.json');
  const scriptPath = path.join(directory, 'harness.ts');
  fs.writeFileSync(inputPath, JSON.stringify(cases));
  fs.writeFileSync(
    scriptPath,
    `
import { readFileSync, writeFileSync } from 'node:fs';
import { ReportingConsumerStatusSchema, SyncReportingStatusRequestSchema, SyncReportingStatusResponseSchema } from ${JSON.stringify(GENERATED)};
const schemas = { status: ReportingConsumerStatusSchema, request: SyncReportingStatusRequestSchema, response: SyncReportingStatusResponseSchema };
const cases = JSON.parse(readFileSync(${JSON.stringify(inputPath)}, 'utf8'));
writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({
  direct: cases.map(entry => schemas[entry.schema].safeParse(entry.value).success),
  safeExtended: cases.map(entry => schemas[entry.schema].safeExtend({}).safeParse(entry.value).success),
}));
`
  );
  try {
    const result = spawnSync('npx', ['tsx', scriptPath], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, `generated Zod harness failed:\n${result.stderr}\n${result.stdout}`);
    return JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('generated consumer-status schemas preserve published rc.2 wire constraints', async () => {
  const expected = cases.map(entry => entry.expected);
  assert.deepEqual(await authoritativeOutcomes(), expected, 'fixture expectations match the published JSON Schemas');
  const generated = generatedOutcomes();
  assert.deepEqual(generated.direct, expected, 'public Zod exports match the published JSON Schemas');
  assert.deepEqual(generated.safeExtended, expected, 'safeExtend preserves the public schema refinements');
});
