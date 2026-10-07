const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { assertExpectedBinding } = require('../../dist/lib/reporting/gcs/validation');
// Pure validation over pinned protocol fixtures; no provider or agent response is fabricated.
const fixture = JSON.parse(readFileSync('test/fixtures/reporting-interop/evidence-v1.json'));
const r = fixture.revision,
  m = fixture.materialization;
const binding = {
  verification_profile: 'canonical_digest',
  destination_ref: m.destination_ref,
  method: m.method,
  delivery_config_id: m.delivery_config_id,
  delivery_config_version: m.delivery_config_version,
  feed_purpose: m.feed_purpose,
  reconciliation_mode: fixture.obligation.reconciliation_mode,
};
const input = {
  binding,
  revision: { wireRevision: r },
  obligation: { requiredFinality: fixture.obligation.required_finality },
};
const expected = {
  verificationProfile: binding.verification_profile,
  destinationRef: binding.destination_ref,
  deliveryMethod: binding.method,
  deliveryConfigId: binding.delivery_config_id,
  deliveryConfigVersion: binding.delivery_config_version,
  reportDefinitionId: r.report_definition_id,
  feedPurpose: binding.feed_purpose,
  reportingProfile: r.reporting_profile,
  reconciliationMode: binding.reconciliation_mode,
  requiredFinality: input.obligation.requiredFinality,
  periodStart: r.period.start,
  periodEnd: r.period.end,
  mediaBuyIds: r.media_buy_ids,
  reportDefinitionUri: r.report_definition_uri,
  reportDefinitionSha256: r.report_definition_sha256,
  schemaUri: r.schema_uri,
  schemaSha256: r.schema_sha256,
  schemaVersion: r.schema_version,
  schemaDialect: r.schema_dialect,
  schemaRefPolicy: r.schema_ref_policy,
  officialFinality: { policyId: r.finality_policy_id, basis: r.finality_basis },
  coverage: r.coverage,
  canonicalization: {
    id: r.canonical_content_digest.canonicalization_id,
    uri: r.canonical_content_digest.canonicalization_uri,
    sha256: r.canonical_content_digest.canonicalization_sha256,
    primaryKeys: ['media_buy_id', 'date'],
  },
};
test('producer readiness requires each independently saved contract and scope pin', () => {
  assert.doesNotThrow(() => assertExpectedBinding(input, expected));
  assert.doesNotThrow(() =>
    assertExpectedBinding(input, {
      ...expected,
      schemaSha256: expected.schemaSha256.toUpperCase(),
      reportDefinitionSha256: expected.reportDefinitionSha256.toUpperCase(),
    })
  );
  const changes = [
    ['verificationProfile', 'manifest_checksums'],
    ['destinationRef', 'outside'],
    ['deliveryMethod', 'dataset_share'],
    ['deliveryConfigId', 'outside'],
    ['deliveryConfigVersion', 2],
    ['reportDefinitionId', 'outside'],
    ['feedPurpose', 'analytics'],
    ['reportingProfile', 'outside'],
    ['reconciliationMode', 'delivery_only'],
    ['requiredFinality', 'snapshot'],
    ['periodStart', '2026-07-01T00:00:00Z'],
    ['periodEnd', '2026-08-01T00:00:00Z'],
    ['mediaBuyIds', ['outside']],
    ['reportDefinitionUri', 'https://outside.example/definition'],
    ['reportDefinitionSha256', '0'.repeat(64)],
    ['schemaUri', 'https://outside.example/schema'],
    ['schemaSha256', '0'.repeat(64)],
    ['schemaVersion', 'outside'],
    ['schemaDialect', 'draft-07'],
    ['schemaRefPolicy', 'outside'],
    ['officialFinality', { policyId: 'outside', basis: 'contractual_cutoff' }],
    ['officialFinality', undefined],
    ['coverage', {}],
    ['coverage', { ...r.coverage, package_ids: ['outside'] }],
    ['canonicalization', { ...expected.canonicalization, id: 'outside' }],
    ['canonicalization', { ...expected.canonicalization, uri: 'https://outside.example/contract' }],
    ['canonicalization', { ...expected.canonicalization, sha256: '0'.repeat(64) }],
  ];
  for (const [key, value] of changes)
    assert.throws(() => assertExpectedBinding(input, { ...expected, [key]: value }), { code: 'CONTENT_CONFLICT' }, key);
  const added = structuredClone(input);
  added.revision.wireRevision.coverage.new_scope = ['unexpected'];
  assert.throws(() => assertExpectedBinding(added, expected), { code: 'CONTENT_CONFLICT' });
});
