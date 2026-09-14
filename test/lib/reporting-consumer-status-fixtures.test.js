const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  ReportingConsumerStatusV1Schema,
  SyncReportingStatusRequestV1Schema,
} = require('../../dist/lib/reporting/ledger/index.js');
const publishedFixtureExport = require('@adcp/sdk/compliance-fixtures/reporting-consumer-status-v1.json');

const directory = path.resolve(__dirname, '../fixtures/reporting-reconciliation');
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'fixture.json'), 'utf8'));
const fixtureBytes = fs.readFileSync(path.join(directory, 'consumer-status.json'));
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonicalJson = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
};

test('portable consumer-status vectors retain exact bytes, clocks, principals, results, and ledger state', () => {
  const publishedBytes = fs.readFileSync(
    path.resolve(__dirname, '../../dist/lib/compliance-fixtures/reporting-consumer-status-v1.json')
  );
  assert.deepEqual(publishedBytes, fixtureBytes);
  assert.deepEqual(publishedFixtureExport, fixture);
  assert.equal(fixtureBytes.byteLength, manifest.files['consumer-status.json'].size_bytes);
  assert.equal(sha256(fixtureBytes), manifest.files['consumer-status.json'].sha256);
  assert.equal(fixture.protocol_version, '3.2.0-rc.3');
  assert.deepEqual(
    fixture.frozen.expected_periods.map(period => Date.parse(period.end) - Date.parse(period.start)),
    [82_800_000, 90_000_000, 2_419_200_000]
  );

  let inputCount = 0;
  for (const scenarios of Object.values(fixture.scenario_groups)) {
    for (const scenario of scenarios) {
      assert.ok(scenario.principal);
      assert.ok(scenario.clock);
      assert.ok(scenario.post_state && typeof scenario.post_state === 'object');
      const inputs = scenario.concurrent_inputs ?? [scenario];
      for (const input of inputs) {
        const bytes = Buffer.from(input.input_utf8_base64, 'base64');
        assert.equal(sha256(bytes), input.input_sha256, scenario.id);
        assert.equal(bytes.toString('utf8'), JSON.stringify(input.request), scenario.id);
        inputCount += 1;
      }
      assert.ok(scenario.expected_results || scenario.expected_results_unordered);
    }
  }
  assert.ok(inputCount >= 16);

  const bindings = [fixture.frozen.core_revision_binding, fixture.frozen.restated_core_revision_binding];
  for (const binding of bindings) {
    const bindingBytes = Buffer.from(binding.canonical_json_utf8_base64, 'base64');
    assert.equal(bindingBytes.toString('utf8'), canonicalJson(binding.value));
    assert.equal(sha256(bindingBytes), binding.sha256);
    assert.deepEqual(Object.keys(binding.value).sort(), [
      'control_totals',
      'reporting_revision_id',
      'reporting_rows',
      'row_count',
    ]);
  }

  const digestByRevision = new Map(bindings.map(binding => [binding.value.reporting_revision_id, binding.sha256]));
  const inspect = value => {
    if (Array.isArray(value)) return value.forEach(inspect);
    if (!value || typeof value !== 'object') return;
    if (value.consumer_status === 'received') {
      assert.equal(value.observed_revision_content_sha256, digestByRevision.get(value.reporting_revision_id));
    }
    Object.values(value).forEach(inspect);
  };
  inspect(fixture.wire_parity);
  inspect(fixture.scenario_groups);

  const restatement = fixture.scenario_groups.repair_and_restatement;
  const mismatchIndex = restatement.findIndex(scenario => scenario.id === 'seller-restatement-mismatch');
  const readbackIndex = restatement.findIndex(scenario => scenario.id === 'seller-restatement-readback');
  assert.ok(mismatchIndex > 0 && mismatchIndex < readbackIndex);
  const mismatch = restatement[mismatchIndex];
  assert.equal(mismatch.seller_state.current_revision, 'portable-revision-0002');
  assert.equal(mismatch.request.statuses[0].reporting_revision_id, 'portable-revision-0001');
  assert.equal(mismatch.post_state.current_leaf, 'portable-status-repaired-0001');
  assert.equal(mismatch.post_state.mismatch, true);
  assert.equal(restatement[readbackIndex].post_state.mismatch, false);
});

test('portable wire-parity statuses cover all four rc.2 states and reject every declared mutation', () => {
  const statuses = new Map(
    fixture.wire_parity.valid_statuses.map(status => [status.consumer_status, structuredClone(status)])
  );
  assert.deepEqual([...statuses.keys()].sort(), ['obligation_missing', 'received', 'revision_missing', 'unreadable']);
  for (const status of statuses.values()) assert.equal(ReportingConsumerStatusV1Schema.safeParse(status).success, true);

  for (const mutation of fixture.wire_parity.invalid_status_mutations) {
    const value = structuredClone(statuses.get(mutation.base));
    for (const field of mutation.remove ?? []) delete value[field];
    Object.assign(value, mutation.add ?? {});
    Object.assign(value.period, mutation.add_period ?? {});
    const parsed = SyncReportingStatusRequestV1Schema.safeParse({
      account: { account_id: 'portable-account-0001' },
      idempotency_key: `portable-invalid-${mutation.id}`,
      statuses: [value],
    });
    assert.equal(parsed.success, false, mutation.id);
  }
});
