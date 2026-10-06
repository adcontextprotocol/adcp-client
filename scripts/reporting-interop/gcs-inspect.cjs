'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const [evidenceRoot, packageRoot, nodeName, phase] = process.argv.slice(2);

async function fails(work, code, message) {
  try {
    await work();
  } catch (error) {
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return;
  }
  throw new Error('negative control unexpectedly passed');
}

async function main() {
  assert.equal(process.argv.slice(2).length, 4, 'argument count');
  assert.ok(['node20', 'node24'].includes(nodeName), 'runtime label');
  assert.ok(['positive', 'tampered', 'revoked'].includes(phase), 'phase');
  assert.ok(process.version.startsWith(nodeName === 'node20' ? 'v20.' : 'v24.'), 'actual runtime');
  const root = path.resolve(evidenceRoot);
  const req = createRequire(path.resolve(packageRoot, 'package.json'));
  const installedSdk = fs.realpathSync(path.resolve(packageRoot, 'node_modules/@adcp/sdk'));
  assert.ok(fs.realpathSync(req.resolve('@adcp/sdk')).startsWith(installedSdk + path.sep), 'installed SDK path');
  const installedVersion = JSON.parse(fs.readFileSync(path.join(installedSdk, 'package.json'))).version;
  const api = req('@adcp/sdk');
  const consumer = req('@adcp/sdk/reporting/consumer');
  const context = JSON.parse(fs.readFileSync(path.join(root, 'evidence', `${nodeName}-context.json`)));
  const expected = JSON.parse(fs.readFileSync(path.join(root, 'evidence/expected.json')));
  const tokenFile = path.join(root, 'reader-token.json');
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600, 'private token file mode');
  const privateBytes = fs.readFileSync(tokenFile);
  const privateToken = JSON.parse(privateBytes);
  const credential = {
    headers: { authorization: `Bearer ${privateToken.token}` },
    allowedOrigins: ['https://storage.googleapis.com'],
  };
  const reader = api.createHttpsReportingResourceReader({ timeoutMs: 15000 });
  const manifest = {
    role: 'manifest',
    location: context.materialization.resource.location,
    maxBytes: 65536,
    context,
    credential,
  };
  const inspector = api.createReportingManifestInspector({
    reader,
    credentialProvider: {
      async getCredentials() {
        return credential;
      },
    },
    referenceAllowedOrigins: ['https://storage.googleapis.com'],
    referenceResolver: {
      cache: { get() {}, set() {} },
      async resolve(ref) {
        const result = await reader.read({ ...manifest, location: ref.uri });
        const bytes = Buffer.from(result.body);
        assert.equal(ref.digest, `sha256:${sha(bytes)}`);
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
          contentType: result.contentType,
          httpStatus: 200,
        };
      },
    },
  });
  let checks;
  if (phase === 'positive') {
    const observation = await inspector(context);
    assert.equal(observation.rowCount, expected.row_count);
    assert.deepEqual(observation.controlTotals, expected.control_totals);
    assert.equal(observation.canonicalContentDigest.value, expected.canonical_content_sha256);
    const receipt = consumer.buildReportingReceipt(
      context,
      observation,
      'receipt-gcs-qualified',
      '2026-09-02T01:00:00Z'
    );
    assert.equal(receipt.status, 'accepted');
    await fails(() => reader.read({ ...manifest, maxBytes: 1 }), 'RESOURCE_TOO_LARGE');
    await fails(() => reader.read({ ...manifest, credential: undefined }), 'RESOURCE_READ_FAILED', /HTTP 403/);
    const outside = new URL(manifest.location);
    outside.pathname = '/' + outside.pathname.split('/')[1] + '/outside/rows.jsonl';
    await fails(() => reader.read({ ...manifest, location: outside.href }), 'RESOURCE_READ_FAILED', /HTTP 403/);
    await fails(
      () => reader.read({ ...manifest, location: 'https://unauthorized.example.test/private' }),
      'RESOURCE_READ_FAILED',
      /credential is not authorized/
    );
    checks = {
      authenticated_network_inspection: true,
      canonical_digest_verified: true,
      accepted_receipt: true,
      response_byte_limit_enforced: true,
      anonymous_access_denied_403: true,
      outside_prefix_denied_403: true,
      credential_origin_boundary: true,
      contract_digest_checks: 'worker_reference_resolver_over_sdk_https_reader',
    };
  } else if (phase === 'tampered') {
    await fails(() => inspector(context), 'OBJECT_DIGEST_MISMATCH');
    checks = { network_object_tampering_rejected: true };
  } else if (phase === 'revoked') {
    assert.match(privateToken.expires_at, /(?:Z|[+-]\d{2}:\d{2})$/, 'token expiry timezone required');
    assert.ok(Date.parse(privateToken.expires_at) > Date.now() + 60000);
    const objects = [
      'manifest.json',
      'rows.jsonl',
      'row-schema.json',
      'report-definition.json',
      'canonicalization.json',
    ];
    for (const object of objects) {
      await fails(
        () => reader.read({ ...manifest, location: new URL(object, manifest.location).href }),
        'RESOURCE_READ_FAILED',
        /HTTP 403/
      );
    }
    checks = { revoked_retained_token_denied_403: true, token_unexpired: true, revoked_objects_denied_403: objects };
  } else {
    throw new Error('unknown phase');
  }
  return {
    status: 'passed',
    language: 'typescript',
    node: process.version,
    paired_runtime: nodeName,
    typescript_sdk_version: installedVersion,
    typescript_install_relative_path: 'node_modules/@adcp/sdk',
    reader_credential_file_sha256: sha(privateBytes),
    phase,
    ...checks,
  };
}

main()
  .then(value => process.stdout.write(JSON.stringify(value) + '\n'))
  .catch(error => {
    // Never print Google OAuth credentials, transport responses, or raw exceptions.
    process.stderr.write(
      JSON.stringify({
        status: 'failed',
        phase: ['positive', 'tampered', 'revoked'].includes(phase) ? phase : 'invalid',
        error_type: error.name,
        code: typeof error.code === 'string' && /^[A-Z][A-Z_0-9]{0,80}$/.test(error.code) ? error.code : undefined,
      }) + '\n'
    );
    process.exitCode = 1;
  });
