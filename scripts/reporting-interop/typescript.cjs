const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function run({ packageRoot, fixtureRoot, peer }) {
  const req = createRequire(path.resolve(packageRoot, 'package.json'));
  const sdk = req('@adcp/sdk/reporting/consumer');
  const { canonicalize, ADCP_VERSION } = req('@adcp/sdk');
  const fixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'reporting-interop/evidence-v1.json')));
  assert.equal(fixture.contract, 'reporting_evidence_interop_v1');
  assert.equal(fixture.version, 1);
  assert.equal(ADCP_VERSION, fixture.adcp_schema_version);
  const canonicalVectors = JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, 'reporting-interop/canonical-json-v1.json'))
  ).vectors;
  for (const vector of canonicalVectors) {
    const bytes = Buffer.from(canonicalize(vector.value));
    assert.equal(bytes.toString('hex'), vector.canonical_utf8_hex, vector.name);
    assert.equal(sha256(bytes), vector.sha256, vector.name);
  }
  const revisionBytes = Buffer.from(canonicalize(fixture.revision_binding.value));
  assert.equal(revisionBytes.toString('hex'), fixture.revision_binding.canonical_utf8_hex);
  assert.equal(sha256(revisionBytes), fixture.revision_binding.sha256);
  assert.equal(sha256(revisionBytes), fixture.revision.revision_content_sha256);

  const resources = new Map();
  const resourceDir = path.join(fixtureRoot, 'reporting-interop/resources');
  const pins = JSON.parse(fs.readFileSync(path.join(resourceDir, 'fixture.json')));
  for (const name of [
    'manifest.json',
    'rows.jsonl',
    'row-schema.json',
    'report-definition.json',
    'canonicalization.json',
  ]) {
    const bytes = fs.readFileSync(path.join(resourceDir, name));
    assert.equal(sha256(bytes), pins.files[name].sha256, name);
    assert.equal(bytes.length, pins.files[name].size_bytes, name);
    resources.set(name, bytes);
  }
  // Each producer emits its own SDK-canonicalized manifest. The other SDK
  // inspects those exact bytes, never a reserialized model of the peer output.
  const manifest = Buffer.from(canonicalize(JSON.parse(resources.get('manifest.json'))));
  const manifestDigest = sha256(manifest);
  if (peer) {
    assert.equal(peer.contract, fixture.contract);
    assert.equal(peer.version, fixture.version);
    assert.equal(peer.adcp_schema_version, fixture.adcp_schema_version);
    assert.equal(peer.manifest_utf8_base64, manifest.toString('base64'));
    assert.equal(peer.manifest_sha256, manifestDigest);
  }
  resources.set('manifest.json', peer ? Buffer.from(peer.manifest_utf8_base64, 'base64') : manifest);
  const context = {
    obligation: fixture.obligation,
    revision: fixture.revision,
    materialization: structuredClone(fixture.materialization),
    expected: fixture.expected,
  };
  context.materialization.resource.manifest_sha256 = manifestDigest;
  const contractUris = {
    [context.revision.schema_uri]: 'row-schema.json',
    [context.revision.report_definition_uri]: 'report-definition.json',
    [context.revision.canonical_content_digest.canonicalization_uri]: 'canonicalization.json',
  };
  const inspect = req('@adcp/sdk').createReportingManifestInspector({
    reader: {
      async read(request) {
        const name = request.role === 'manifest' ? 'manifest.json' : request.objectRef;
        const bytes = resources.get(name);
        assert.ok(bytes, `unknown fixture resource ${name}`);
        return { body: bytes, contentType: request.role === 'manifest' ? 'application/json' : 'application/x-ndjson' };
      },
    },
    referenceResolver: {
      cache: { get() {}, set() {} },
      async resolve(ref) {
        const bytes = resources.get(contractUris[ref.uri]);
        assert.ok(bytes, 'unknown contract reference');
        assert.equal(ref.digest, `sha256:${sha256(bytes)}`);
        return {
          ok: true,
          status: 'resolved',
          kind: 'generic',
          ref,
          cacheKey: ref.uri,
          fromCache: false,
          document: JSON.parse(bytes),
          body: bytes,
          text: bytes.toString('utf8'),
          contentType:
            contractUris[ref.uri] === 'row-schema.json'
              ? 'application/schema+json'
              : contractUris[ref.uri] === 'report-definition.json'
                ? 'application/vnd.adcp.reporting-definition+json'
                : 'application/vnd.adcp.reporting-canonicalization+json',
          httpStatus: 200,
        };
      },
    },
    referenceAllowedOrigins: ['https://schemas.fixture.example.net'],
  });
  const observation = await inspect(context);
  assert.equal(observation.rowCount, pins.expected.row_count);
  assert.deepEqual(observation.controlTotals, pins.expected.control_totals);
  assert.equal(observation.canonicalContentDigest.value, pins.expected.canonical_content_sha256);
  const revisionReceipts = [0, 1].map(delta =>
    sdk.buildReportingReceipt(
      context,
      { ...observation, rowCount: observation.rowCount + delta },
      `receipt-revision-${delta}`,
      fixture.observed_at
    )
  );
  assert.equal(revisionReceipts[0].status, 'accepted');
  assert.equal(revisionReceipts[1].status, 'rejected');
  const adjustments = fixture.adjustments.map(vector => {
    const unsigned = { ...vector.adjustment };
    delete unsigned.canonical_adjustment_sha256;
    const bytes = Buffer.from(canonicalize(unsigned));
    assert.equal(bytes.toString('hex'), vector.canonical_utf8_hex, vector.id);
    assert.equal(sha256(bytes), vector.sha256, vector.id);
    const receipt = sdk.buildReportingAdjustmentReceipt(vector.adjustment, fixture.revision, {
      reportingReceiptId: vector.expected_receipt.reporting_receipt_id,
      observedAt: fixture.observed_at,
      ...(vector.current_receipt ? { supersedesReportingReceiptId: vector.current_receipt.reporting_receipt_id } : {}),
    });
    assert.deepEqual(receipt, vector.expected_receipt, vector.id);
    return { id: vector.id, canonical_utf8_hex: bytes.toString('hex'), receipt };
  });
  const output = {
    contract: fixture.contract,
    version: fixture.version,
    adcp_schema_version: ADCP_VERSION,
    manifest_utf8_base64: manifest.toString('base64'),
    manifest_sha256: manifestDigest,
    revision_content_utf8_base64: revisionBytes.toString('base64'),
    revision_receipts: revisionReceipts,
    adjustments,
  };
  if (peer) {
    assert.deepEqual(peer, {
      ...output,
      adjustments: fixture.adjustments.map(vector => ({
        id: vector.id,
        canonical_utf8_hex: vector.canonical_utf8_hex,
        receipt: vector.expected_python_receipt ?? vector.expected_receipt,
      })),
    });
  }
  return output;
}

module.exports = { run };
if (require.main === module) {
  const [packageRoot, fixtureRoot, peerFile] = process.argv.slice(2);
  run({ packageRoot, fixtureRoot, peer: peerFile ? JSON.parse(fs.readFileSync(peerFile)) : undefined })
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
}
