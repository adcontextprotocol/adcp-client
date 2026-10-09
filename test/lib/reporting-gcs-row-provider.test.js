/**
 * GCS row-object provider against an in-memory fake of the official
 * `@google-cloud/storage` surface it uses (bucket(), file(name, { generation }),
 * save, getMetadata, createReadStream, delete).
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable } = require('node:stream');
const { test } = require('node:test');

const { createGcsReportingRowObjectProviderV1 } = require('../../dist/lib/reporting/gcs');
const { assertGcsReportingRowBucketPolicyV1 } = require('../../dist/lib/reporting/gcs/row-provider');
const {
  isReportingRowStoreError,
  runReportingRowObjectProviderConformanceV1,
} = require('../../dist/lib/reporting/ledger');

const SECRET = 'ya29.secret-access-token';

function apiError(code) {
  // Real ApiErrors carry request details; the provider must never surface them.
  return Object.assign(new Error(`HTTP ${code} for gs://bucket/key token=${SECRET}`), { code });
}

const safeBucket = () => ({
  iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced' },
  versioning: { enabled: true },
  softDeletePolicy: { retentionDurationSeconds: '604800' },
  retentionPolicy: { retentionPeriod: '86400' },
});

function createFakeStorage({ bucketMetadata = safeBucket(), buckets = ['rows-bucket'] } = {}) {
  const objects = new Map(); // `${bucket}/${name}` -> [{ generation, bytes, metadata }]
  let nextGeneration = 1_700_000_000_000_001;
  const calls = [];
  const failures = {}; // op -> error to throw once
  const fail = op => {
    const error = failures[op];
    if (error) {
      delete failures[op];
      throw error;
    }
  };
  const live = path => {
    const versions = objects.get(path) ?? [];
    return versions.find(version => version.live);
  };
  const at = (path, generation) => {
    const versions = objects.get(path) ?? [];
    if (generation === undefined) return live(path);
    return versions.find(version => String(version.generation) === String(generation));
  };
  const storage = {
    calls,
    failures,
    objects,
    bucket(bucketName) {
      return {
        name: bucketName,
        async getMetadata() {
          calls.push({ op: 'bucket.getMetadata', bucketName });
          fail('bucket.getMetadata');
          if (!buckets.includes(bucketName)) throw apiError(404);
          return [structuredClone(bucketMetadata)];
        },
        file(name, options = {}) {
          const path = `${bucketName}/${name}`;
          const pinned = options.generation;
          const file = {
            name,
            metadata: {},
            async save(bytes, saveOptions) {
              calls.push({ op: 'save', name, options: structuredClone(saveOptions) });
              fail('save');
              if (!buckets.includes(bucketName)) throw apiError(404);
              const precondition = saveOptions?.preconditionOpts?.ifGenerationMatch;
              const current = live(path);
              if (precondition === 0 && current) throw apiError(412);
              if (current) current.live = false;
              const version = {
                generation: nextGeneration++,
                bytes: Buffer.from(bytes),
                metadata: saveOptions?.metadata,
                live: true,
              };
              objects.set(path, [...(objects.get(path) ?? []), version]);
              file.metadata = { generation: String(version.generation), size: String(version.bytes.length) };
            },
            async getMetadata() {
              calls.push({ op: 'file.getMetadata', name, generation: pinned });
              fail('file.getMetadata');
              const version = at(path, pinned);
              if (!version) throw apiError(404);
              return [{ generation: String(version.generation), size: String(version.bytes.length) }];
            },
            createReadStream(readOptions = {}) {
              calls.push({ op: 'createReadStream', name, generation: pinned, options: { ...readOptions } });
              const version = at(path, pinned);
              if (failures.createReadStream) {
                const error = failures.createReadStream;
                delete failures.createReadStream;
                return new Readable({
                  read() {
                    this.destroy(error);
                  },
                });
              }
              if (!version) {
                return new Readable({
                  read() {
                    this.destroy(apiError(404));
                  },
                });
              }
              const start = readOptions.start ?? 0;
              if (start >= version.bytes.length && version.bytes.length > 0) {
                return new Readable({
                  read() {
                    this.destroy(apiError(416));
                  },
                });
              }
              const end = readOptions.end === undefined ? version.bytes.length : readOptions.end + 1;
              const slice = version.bytes.subarray(start, end);
              // Emit in small chunks so the streaming cap is exercised.
              const parts = [];
              for (let offset = 0; offset < slice.length; offset += 4) parts.push(slice.subarray(offset, offset + 4));
              return Readable.from(parts);
            },
            async delete(deleteOptions = {}) {
              calls.push({ op: 'delete', name, generation: pinned, options: { ...deleteOptions } });
              fail('delete');
              const version = at(path, pinned);
              if (!version) throw apiError(404);
              if (
                deleteOptions.ifGenerationMatch !== undefined &&
                String(live(path)?.generation) !== String(deleteOptions.ifGenerationMatch)
              )
                throw apiError(412);
              objects.set(
                path,
                objects.get(path).filter(item => item !== version)
              );
            },
          };
          return file;
        },
      };
    },
  };
  return storage;
}

const signal = () => ({ signal: AbortSignal.timeout(5_000) });
const base = { location: { bucket: 'rows-bucket' } };
const put = (provider, key, body = '{"a":1}\n', extra = {}) =>
  provider.putIfAbsent(
    {
      ...base,
      key,
      bytes: Buffer.from(body),
      contentType: 'application/gzip',
      metadata: { 'adcp-installation': 'inst', 'adcp-intent': 'intent' },
      ...extra,
    },
    signal()
  );
const isCode = code => error => isReportingRowStoreError(error) && error.code === code;
const secretFree = error => {
  assert.ok(isReportingRowStoreError(error));
  assert.doesNotMatch(error.message, /secret|token|gs:\/\//);
  return true;
};

test('passes the shared provider conformance suite', async () => {
  const provider = createGcsReportingRowObjectProviderV1({ storage: createFakeStorage() });
  const passed = await runReportingRowObjectProviderConformanceV1(provider, { ...base, prefix: 'adcp-rows' });
  assert.deepEqual(passed, [
    'probe',
    'create',
    'create-only',
    'ranged-read',
    'version-pinned-read',
    'exact-version-delete',
  ]);
});

test('create-only upload: ifGenerationMatch 0, single request, no Content-Encoding', async () => {
  const storage = createFakeStorage();
  const provider = createGcsReportingRowObjectProviderV1({ storage });
  const created = await put(provider, 'adcp-rows/ns/a.jsonl.gz');
  assert.equal(created.created, true);
  assert.match(created.nativeVersion, /^[1-9][0-9]+$/);
  const save = storage.calls.find(call => call.op === 'save');
  assert.deepEqual(save.options.preconditionOpts, { ifGenerationMatch: 0 });
  assert.equal(save.options.resumable, false);
  assert.equal(save.options.gzip, false);
  assert.equal(save.options.contentType, 'application/gzip');
  assert.equal(save.options.validation, false);
  assert.equal(save.options.metadata.contentEncoding, undefined);
  assert.equal(
    save.options.metadata.md5Hash,
    require('node:crypto').createHash('md5').update('{"a":1}\n').digest('base64')
  );
  assert.deepEqual(save.options.metadata.metadata, { 'adcp-installation': 'inst', 'adcp-intent': 'intent' });
});

test('conflict adopts the existing generation without replacing it', async () => {
  const storage = createFakeStorage();
  const provider = createGcsReportingRowObjectProviderV1({ storage });
  const first = await put(provider, 'adcp-rows/ns/a.jsonl', 'first\n');
  const second = await put(provider, 'adcp-rows/ns/a.jsonl', 'second\n');
  assert.deepEqual(second, { created: false, nativeVersion: first.nativeVersion });
  const bytes = await provider.get(
    { ...base, key: 'adcp-rows/ns/a.jsonl', nativeVersion: first.nativeVersion, maxBytes: 100 },
    signal()
  );
  assert.equal(Buffer.from(bytes).toString(), 'first\n');
});

test('reads pin the generation, disable transcoding, and honour ranges', async () => {
  const storage = createFakeStorage();
  const provider = createGcsReportingRowObjectProviderV1({ storage });
  const { nativeVersion } = await put(provider, 'adcp-rows/ns/r.jsonl', '0123456789abcdef');
  const ranged = await provider.get(
    { ...base, key: 'adcp-rows/ns/r.jsonl', nativeVersion, range: { offset: 4, length: 6 }, maxBytes: 6 },
    signal()
  );
  assert.equal(Buffer.from(ranged).toString(), '456789');
  const read = storage.calls.find(call => call.op === 'createReadStream');
  assert.equal(read.generation, nativeVersion);
  assert.equal(read.options.decompress, false);
  assert.equal(read.options.start, 4);
  assert.equal(read.options.end, 9);
  assert.equal(
    await provider.get({ ...base, key: 'adcp-rows/ns/r.jsonl', nativeVersion: '17', maxBytes: 100 }, signal()),
    null
  );
  assert.equal(
    await provider.get({ ...base, key: 'adcp-rows/ns/r.jsonl', nativeVersion: 'abc', maxBytes: 100 }, signal()),
    null
  );
  assert.equal(
    await provider.get({ ...base, key: 'adcp-rows/ns/missing', nativeVersion, maxBytes: 100 }, signal()),
    null
  );
  const empty = await provider.get(
    { ...base, key: 'adcp-rows/ns/r.jsonl', nativeVersion, range: { offset: 3, length: 0 }, maxBytes: 0 },
    signal()
  );
  assert.equal(empty.length, 0);
});

test('maxBytes caps streamed reads and out-of-range requests fail integrity', async () => {
  const provider = createGcsReportingRowObjectProviderV1({ storage: createFakeStorage() });
  const { nativeVersion } = await put(provider, 'adcp-rows/ns/big.jsonl', 'x'.repeat(64));
  await assert.rejects(
    provider.get({ ...base, key: 'adcp-rows/ns/big.jsonl', nativeVersion, maxBytes: 10 }, signal()),
    isCode('ROWS_INTEGRITY_FAILED')
  );
  await assert.rejects(
    provider.get(
      { ...base, key: 'adcp-rows/ns/big.jsonl', nativeVersion, range: { offset: 0, length: 20 }, maxBytes: 10 },
      signal()
    ),
    isCode('ROWS_INTEGRITY_FAILED')
  );
  await assert.rejects(
    provider.get(
      { ...base, key: 'adcp-rows/ns/big.jsonl', nativeVersion, range: { offset: 100, length: 4 }, maxBytes: 10 },
      signal()
    ),
    isCode('ROWS_INTEGRITY_FAILED')
  );
});

test('delete targets the exact generation and is idempotent', async () => {
  const storage = createFakeStorage();
  const provider = createGcsReportingRowObjectProviderV1({ storage });
  const { nativeVersion } = await put(provider, 'adcp-rows/ns/d.jsonl');
  const key = 'adcp-rows/ns/d.jsonl';
  assert.equal(await provider.delete({ ...base, key, nativeVersion: '17' }, signal()), 'absent');
  assert.equal(await provider.delete({ ...base, key, nativeVersion: 'garbage' }, signal()), 'absent');
  assert.equal(await provider.delete({ ...base, key, nativeVersion }, signal()), 'deleted');
  assert.equal(storage.calls.filter(call => call.op === 'delete').at(-1).generation, nativeVersion);
  assert.equal(await provider.delete({ ...base, key, nativeVersion }, signal()), 'absent');
  storage.failures.delete = apiError(412);
  assert.equal(await provider.delete({ ...base, key, nativeVersion }, signal()), 'absent');
});

test('probe refuses missing buckets, ACL/public buckets, and lifecycle deletes over the prefix', async () => {
  const probe = (storage, prefix = 'adcp-rows') =>
    createGcsReportingRowObjectProviderV1({ storage }).probe({ ...base, prefix }, signal());
  await probe(createFakeStorage());
  await assert.rejects(probe(createFakeStorage({ buckets: [] })), isCode('UNSAFE_BINDING'));
  const forbidden = createFakeStorage();
  forbidden.failures['bucket.getMetadata'] = apiError(403);
  await assert.rejects(probe(forbidden), isCode('UNSAFE_BINDING'));
  const unsafe = [
    { iamConfiguration: { uniformBucketLevelAccess: { enabled: false }, publicAccessPrevention: 'enforced' } },
    { iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'inherited' } },
    { lifecycle: { rule: [{ action: { type: 'Delete' }, condition: { age: 30 } }] } },
    { lifecycle: { rule: [{ action: { type: 'Delete' }, condition: { age: 30, matchesPrefix: ['adcp'] } }] } },
    { lifecycle: { rule: [{ action: { type: 'Delete' }, condition: { matchesPrefix: ['adcp-rows/ns/'] } }] } },
    { lifecycle: { rule: [{ action: { type: 'Delete' }, condition: { matchesSuffix: ['.gz'] } }] } },
  ];
  for (const drift of unsafe) {
    await assert.rejects(probe(createFakeStorage({ bucketMetadata: { ...safeBucket(), ...drift } })), error => {
      assert.ok(isCode('UNSAFE_BINDING')(error));
      return secretFree(error);
    });
  }
  const allowed = [
    { lifecycle: { rule: [{ action: { type: 'Delete' }, condition: { age: 30, matchesPrefix: ['tmp/'] } }] } },
    {
      lifecycle: { rule: [{ action: { type: 'Delete' }, condition: { age: 30, matchesPrefix: ['adcp-rows-old/'] } }] },
    },
    { lifecycle: { rule: [{ action: { type: 'Delete' }, condition: { isLive: false, age: 7 } }] } },
    { lifecycle: { rule: [{ action: { type: 'Delete' }, condition: { numNewerVersions: 2 } }] } },
    { lifecycle: { rule: [{ action: { type: 'Delete' }, condition: { daysSinceNoncurrentTime: 7 } }] } },
    {
      lifecycle: { rule: [{ action: { type: 'SetStorageClass', storageClass: 'COLDLINE' }, condition: { age: 30 } }] },
    },
  ];
  for (const drift of allowed) await probe(createFakeStorage({ bucketMetadata: { ...safeBucket(), ...drift } }));
  assert.doesNotThrow(() => assertGcsReportingRowBucketPolicyV1(safeBucket(), 'adcp-rows'));
});

test('credentialRef selects from a closed client map', async () => {
  const primary = createFakeStorage();
  const tenant = createFakeStorage();
  const provider = createGcsReportingRowObjectProviderV1({ storage: primary, clients: { tenant } });
  await put(provider, 'adcp-rows/ns/default.jsonl');
  await put(provider, 'adcp-rows/ns/tenant.jsonl', 'x', { credentialRef: 'tenant' });
  assert.equal(primary.calls.filter(call => call.op === 'save').length, 1);
  assert.equal(tenant.calls.filter(call => call.op === 'save').length, 1);
  await assert.rejects(put(provider, 'adcp-rows/ns/x.jsonl', 'x', { credentialRef: 'unknown' }), error => {
    assert.ok(isCode('UNSAFE_BINDING')(error));
    assert.doesNotMatch(error.message, /unknown/);
    return true;
  });
  const onlyNamed = createGcsReportingRowObjectProviderV1({ clients: { tenant } });
  await assert.rejects(put(onlyNamed, 'adcp-rows/ns/y.jsonl'), isCode('UNSAFE_BINDING'));
  await assert.rejects(
    onlyNamed.probe({ ...base, prefix: 'adcp-rows', credentialRef: 'other' }, signal()),
    isCode('UNSAFE_BINDING')
  );
});

test('location schema is closed and options are validated', () => {
  const provider = createGcsReportingRowObjectProviderV1({ storage: createFakeStorage() });
  provider.validateLocation({ bucket: 'rows-bucket' });
  for (const location of [
    {},
    { bucket: 'Rows' },
    { bucket: 'a' },
    { bucket: 'rows..bucket' },
    { bucket: 'rows-bucket', endpoint: 'https://evil.example' },
    { bucket: 'rows-bucket', key: SECRET },
  ]) {
    assert.throws(() => provider.validateLocation(location), isCode('INVALID_INPUT'));
  }
  assert.throws(() => createGcsReportingRowObjectProviderV1({}), isCode('INVALID_INPUT'));
  assert.throws(() => createGcsReportingRowObjectProviderV1({ storage: {} }), isCode('INVALID_INPUT'));
  assert.throws(
    () => createGcsReportingRowObjectProviderV1({ clients: { 'bad ref': createFakeStorage() } }),
    isCode('INVALID_INPUT')
  );
});

test('provider errors map to stable codes without leaking provider messages', async () => {
  const storage = createFakeStorage();
  const provider = createGcsReportingRowObjectProviderV1({ storage });
  storage.failures.save = apiError(503);
  await assert.rejects(put(provider, 'adcp-rows/ns/e.jsonl'), error => {
    assert.ok(isCode('PROVIDER_UNAVAILABLE')(error));
    return secretFree(error);
  });
  storage.failures['bucket.getMetadata'] = apiError(500);
  await assert.rejects(provider.probe({ ...base, prefix: 'adcp-rows' }, signal()), isCode('PROVIDER_UNAVAILABLE'));
  const { nativeVersion } = await put(provider, 'adcp-rows/ns/e.jsonl');
  storage.failures.createReadStream = apiError(500);
  await assert.rejects(
    provider.get({ ...base, key: 'adcp-rows/ns/e.jsonl', nativeVersion, maxBytes: 100 }, signal()),
    error => isCode('PROVIDER_UNAVAILABLE')(error) && secretFree(error)
  );
  storage.failures.delete = apiError(403);
  await assert.rejects(
    provider.delete({ ...base, key: 'adcp-rows/ns/e.jsonl', nativeVersion }, signal()),
    isCode('PROVIDER_UNAVAILABLE')
  );
});

test('deadlines and cancellation settle even when the client hangs', async () => {
  const storage = createFakeStorage();
  storage.bucket = () => ({
    getMetadata: () => new Promise(() => {}),
    file: () => ({ save: () => new Promise(() => {}) }),
  });
  const provider = createGcsReportingRowObjectProviderV1({ storage });
  await assert.rejects(
    provider.probe({ ...base, prefix: 'adcp-rows' }, { signal: AbortSignal.timeout(20) }),
    isCode('DEADLINE_EXCEEDED')
  );
  const controller = new AbortController();
  const pending = provider.putIfAbsent(
    { ...base, key: 'adcp-rows/ns/h', bytes: Buffer.from('x'), contentType: 'application/x-ndjson', metadata: {} },
    { signal: controller.signal }
  );
  controller.abort();
  await assert.rejects(pending, isCode('ABORTED'));
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    provider.get({ ...base, key: 'k', nativeVersion: '1', maxBytes: 1 }, { signal: aborted.signal }),
    isCode('ABORTED')
  );
});

test('official client wire contract against a local JSON API stub', async () => {
  // Exercises the real @google-cloud/storage client end to end; no network or credentials.
  const { Storage } = require('@google-cloud/storage');
  const objects = new Map();
  const requests = [];
  let generation = 1_700_000_000_000_001;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://stub');
      requests.push({ method: req.method, url, headers: req.headers });
      const json = (code, body) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (/^\/storage\/v1\/b\/[^/]+$/.test(url.pathname)) return json(200, safeBucket());
      if (/^\/upload\/storage\/v1\/b\/[^/]+\/o$/.test(url.pathname)) {
        const name = url.searchParams.get('name');
        const boundary = req.headers['content-type'].split('boundary=')[1];
        const parts = Buffer.concat(chunks).toString('latin1').split(`--${boundary}`);
        const metadata = JSON.parse(parts[1].split('\r\n\r\n')[1]);
        const media = parts[2].slice(parts[2].indexOf('\r\n\r\n') + 4, -2);
        requests.at(-1).metadata = metadata;
        if (url.searchParams.get('ifGenerationMatch') === '0' && objects.has(name)) {
          return json(412, { error: { code: 412, message: 'conditionNotMet' } });
        }
        const object = { generation: String(generation++), bytes: Buffer.from(media, 'latin1') };
        objects.set(name, object);
        return json(200, { name, generation: object.generation, size: String(object.bytes.length) });
      }
      const match = url.pathname.match(/^\/storage\/v1\/b\/[^/]+\/o\/(.+)$/);
      const object = match && objects.get(decodeURIComponent(match[1]));
      const pinned = url.searchParams.get('generation');
      if (!object || (pinned && pinned !== object.generation)) return json(404, { error: { code: 404 } });
      if (req.method === 'DELETE') {
        objects.delete(decodeURIComponent(match[1]));
        res.writeHead(204);
        return res.end();
      }
      if (url.searchParams.get('alt') !== 'media') return json(200, { generation: object.generation });
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
      res.writeHead(range ? 206 : 200);
      res.end(range ? object.bytes.subarray(Number(range[1]), Number(range[2]) + 1) : object.bytes);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const storage = new Storage({ apiEndpoint: `http://127.0.0.1:${server.address().port}`, projectId: 'stub' });
    const provider = createGcsReportingRowObjectProviderV1({ storage });
    await runReportingRowObjectProviderConformanceV1(provider, { ...base, prefix: 'adcp-rows' });
    const uploads = requests.filter(request => request.url.pathname.startsWith('/upload/'));
    assert.equal(uploads.length, 2);
    for (const upload of uploads) {
      assert.equal(upload.url.searchParams.get('uploadType'), 'multipart');
      assert.equal(upload.url.searchParams.get('ifGenerationMatch'), '0');
      assert.equal(upload.metadata.contentEncoding, undefined);
      assert.ok(upload.metadata.md5Hash);
    }
    const media = requests.filter(request => request.url.searchParams.get('alt') === 'media');
    assert.ok(media.length >= 2);
    for (const read of media) {
      assert.match(read.url.searchParams.get('generation'), /^[1-9][0-9]+$/);
      // Asking for gzip disables decompressive transcoding.
      assert.equal(read.headers['accept-encoding'], 'gzip');
    }
    assert.ok(media.some(read => read.headers.range === 'bytes=8-15'));
    const deletes = requests.filter(request => request.method === 'DELETE');
    assert.ok(deletes.every(request => /^[1-9][0-9]+$/.test(request.url.searchParams.get('generation'))));
  } finally {
    server.close();
  }
});
