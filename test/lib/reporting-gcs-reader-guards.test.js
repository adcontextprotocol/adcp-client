const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Storage } = require('@google-cloud/storage');
const {
  createGcsReportingReferenceResolverV1,
  createGcsReportingResourceReaderV1,
} = require('../../dist/lib/reporting/gcs');
const bucket = 'owned-guard-bucket',
  prefix = 'owned/contracts/';
const uri = `https://storage.googleapis.com/${bucket}/${prefix}schema.json`;
const scope = { principal_id: 'host-principal', account_id: 'account', destination_ref: 'destination', generation: 1 };
const options = {
  scope,
  bucket,
  objectPrefix: prefix,
  getStorage: async () => {
    throw new Error('unexpected storage I/O');
  },
  authorize: async () => false,
};

test('private GCS references enforce bucket/prefix and forbid normalized, encoded, queried or credentialed targets', async () => {
  const resolver = createGcsReportingReferenceResolverV1(options);
  const targets = [
    uri.replace(bucket, 'other-bucket'),
    uri.replace(prefix, 'outside/'),
    uri + '?token=SECRET',
    uri + '#x',
    uri.replace('schema.json', '../schema.json'),
    uri.replace('schema.json', '%73chema.json'),
    uri.replace('https://', 'https://user:SECRET@'),
  ];
  for (const target of targets) {
    const result = await resolver.resolve({ uri: target, digest: 'sha256:' + '0'.repeat(64) });
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes('SECRET'));
  }
  const result = await resolver.resolve({ uri, digest: 'sha256:' + '0'.repeat(64) });
  assert.equal(result.error.code, 'access_denied');
});

test('resource reader rejects cross-account/destination and invalid role before provider I/O', async () => {
  const reader = createGcsReportingResourceReaderV1({
    ...options,
    getStorage: async () => new Storage({ projectId: 'fixture-project' }),
  });
  const request = {
    role: 'manifest',
    location: uri,
    maxBytes: 100,
    context: {
      obligation: { account_id: scope.account_id },
      materialization: { destination_ref: scope.destination_ref, resource: { location: uri } },
    },
  };
  for (const change of [
    { role: 'other' },
    { context: { ...request.context, obligation: { account_id: 'other' } } },
    { location: uri.replace(prefix, 'outside/') },
  ])
    await assert.rejects(reader.read({ ...request, ...change }), { code: 'INVALID_INPUT' });
  await assert.rejects(reader.read(request), { code: 'REVOKED' });
});

test('private reader inherits its operation cancellation across resolver calls', async () => {
  const signal = AbortSignal.abort();
  const resolver = createGcsReportingReferenceResolverV1({ ...options, signal });
  const result = await resolver.resolve({ uri, digest: 'sha256:' + '0'.repeat(64) });
  assert.equal(result.error.code, 'aborted');
});
