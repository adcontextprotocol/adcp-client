/**
 * GCS row-object provider against an in-memory fake of the official
 * `@google-cloud/storage` surface it uses (bucket(), file(name, { generation }),
 * save, getMetadata, createReadStream, delete).
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');

const { createGcsReportingRowObjectProviderV1 } = require('../../dist/lib/reporting/gcs');
const { assertGcsReportingRowBucketPolicyV1 } = require('../../dist/lib/reporting/gcs/row-provider');
const {
  isReportingRowStoreError,
  runReportingRowObjectProviderConformanceV1,
} = require('../../dist/lib/reporting/ledger');

const { SECRET, apiError, safeBucket, createFakeStorage } = require('../helpers/fake-gcs-storage.js');

const signal = () => ({ signal: AbortSignal.timeout(5_000) });
const base = { location: { bucket: 'rows-bucket' } };
const put = (provider, key, body = '{"a":1}\n', extra = {}) =>
  provider.putIfAbsent(
    {
      ...base,
      objectRef: key,
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
    'version-pinned-stat',
    'exact-version-delete',
    'write-unique-version',
    'list',
  ]);
});

test('list pages through every generation, noncurrent ones included, under the prefix', async () => {
  const storage = createFakeStorage();
  const provider = createGcsReportingRowObjectProviderV1({ storage });
  const first = await put(provider, 'adcp-rows/ns/a.jsonl', 'one\n');
  // Replace the live object so the first generation becomes noncurrent.
  storage.objects.get('rows-bucket/adcp-rows/ns/a.jsonl')[0].live = false;
  const second = await put(provider, 'adcp-rows/ns/a.jsonl', 'two!\n');
  const third = await put(provider, 'adcp-rows/ns/b.jsonl', 'b\n');
  await put(provider, 'adcp-rows/other/c.jsonl');
  const seen = [];
  let pageToken;
  let pages = 0;
  do {
    const page = await provider.list(
      { ...base, prefix: 'adcp-rows/ns/', pageSize: 1, ...(pageToken ? { pageToken } : {}) },
      signal()
    );
    assert.ok(page.objects.length <= 1);
    seen.push(...page.objects);
    pageToken = page.nextPageToken;
    pages += 1;
  } while (pageToken);
  assert.equal(pages, 3);
  assert.deepEqual(
    seen.map(entry => [entry.objectRef, entry.nativeVersionRef, entry.sizeBytes]),
    [
      ['adcp-rows/ns/a.jsonl', first.nativeVersionRef, 4],
      ['adcp-rows/ns/a.jsonl', second.nativeVersionRef, 5],
      ['adcp-rows/ns/b.jsonl', third.nativeVersionRef, 2],
    ]
  );
  assert.ok(seen.every(entry => Number.isFinite(Date.parse(entry.createdAt))));
  const listing = storage.calls.filter(call => call.op === 'bucket.getFiles');
  assert.equal(listing[0].prefix, 'adcp-rows/ns/');
  await assert.rejects(
    () => provider.list({ ...base, prefix: 'adcp-rows/ns/', pageSize: 0 }, signal()),
    isCode('INVALID_INPUT')
  );
});

test('list leaves out an entry it cannot address or age instead of failing the whole page', async () => {
  const storage = createFakeStorage();
  const provider = createGcsReportingRowObjectProviderV1({ storage });
  const good = await put(provider, 'adcp-rows/ns/good.jsonl');
  const bytes = Buffer.from('x');
  storage.objects.set('rows-bucket/adcp-rows/ns/bad-generation.jsonl', [
    { generation: 'not-a-number', bytes, live: true, timeCreated: new Date().toISOString() },
  ]);
  storage.objects.set('rows-bucket/adcp-rows/ns/bad-time.jsonl', [
    { generation: 1_700_000_000_999_999, bytes, live: true, timeCreated: 'garbage' },
  ]);
  const page = await provider.list({ ...base, prefix: 'adcp-rows/ns/', pageSize: 10 }, signal());
  assert.deepEqual(
    page.objects.map(entry => [entry.objectRef, entry.nativeVersionRef]),
    [['adcp-rows/ns/good.jsonl', good.nativeVersionRef]]
  );
  assert.equal(page.skipped, 2, 'what it left out is counted');
});

test('list reports the later of creation and last update, so an object is never aged past its write', async () => {
  const storage = createFakeStorage();
  const provider = createGcsReportingRowObjectProviderV1({ storage });
  await put(provider, 'adcp-rows/ns/a.jsonl');
  const [version] = storage.objects.get('rows-bucket/adcp-rows/ns/a.jsonl');
  version.timeCreated = '2020-01-01T00:00:00.000Z';
  const original = storage.bucket('rows-bucket').getFiles;
  const stamped = new Date().toISOString();
  const bucket = storage.bucket;
  storage.bucket = name => ({
    ...bucket(name),
    getFiles: async options => {
      const [files, next] = await original.call(bucket(name), options);
      return [files.map(file => ({ ...file, metadata: { ...file.metadata, updated: stamped } })), next];
    },
  });
  const page = await provider.list({ ...base, prefix: 'adcp-rows/ns/', pageSize: 10 }, signal());
  assert.equal(page.objects[0].createdAt, stamped);
});

test('list maps provider failures to a stable code without leaking the provider message', async () => {
  const storage = createFakeStorage();
  const provider = createGcsReportingRowObjectProviderV1({ storage });
  storage.failures['bucket.getFiles'] = apiError(503);
  await assert.rejects(() => provider.list({ ...base, prefix: 'adcp-rows/ns/', pageSize: 10 }, signal()), secretFree);
});

test('create-only upload: ifGenerationMatch 0, single request, no Content-Encoding', async () => {
  const storage = createFakeStorage();
  const provider = createGcsReportingRowObjectProviderV1({ storage });
  const created = await put(provider, 'adcp-rows/ns/a.jsonl.gz');
  assert.equal(created.created, true);
  assert.match(created.nativeVersionRef, /^[1-9][0-9]+$/);
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
  assert.deepEqual(second, { created: false, nativeVersionRef: first.nativeVersionRef });
  const bytes = await provider.get(
    { ...base, objectRef: 'adcp-rows/ns/a.jsonl', nativeVersionRef: first.nativeVersionRef, maxBytes: 100 },
    signal()
  );
  assert.equal(Buffer.from(bytes).toString(), 'first\n');
});

test('reads pin the generation, disable transcoding, and honour ranges', async () => {
  const storage = createFakeStorage();
  const provider = createGcsReportingRowObjectProviderV1({ storage });
  const { nativeVersionRef } = await put(provider, 'adcp-rows/ns/r.jsonl', '0123456789abcdef');
  const ranged = await provider.get(
    { ...base, objectRef: 'adcp-rows/ns/r.jsonl', nativeVersionRef, range: { offset: 4, length: 6 }, maxBytes: 6 },
    signal()
  );
  assert.equal(Buffer.from(ranged).toString(), '456789');
  const read = storage.calls.find(call => call.op === 'createReadStream');
  assert.equal(read.generation, nativeVersionRef);
  assert.equal(read.options.decompress, false);
  assert.equal(read.options.start, 4);
  assert.equal(read.options.end, 9);
  assert.equal(
    await provider.get({ ...base, objectRef: 'adcp-rows/ns/r.jsonl', nativeVersionRef: '17', maxBytes: 100 }, signal()),
    null
  );
  assert.equal(
    await provider.get(
      { ...base, objectRef: 'adcp-rows/ns/r.jsonl', nativeVersionRef: 'abc', maxBytes: 100 },
      signal()
    ),
    null
  );
  assert.equal(
    await provider.get({ ...base, objectRef: 'adcp-rows/ns/missing', nativeVersionRef, maxBytes: 100 }, signal()),
    null
  );
  const empty = await provider.get(
    { ...base, objectRef: 'adcp-rows/ns/r.jsonl', nativeVersionRef, range: { offset: 3, length: 0 }, maxBytes: 0 },
    signal()
  );
  assert.equal(empty.length, 0);
});

test('maxBytes caps streamed reads and out-of-range requests fail integrity', async () => {
  const provider = createGcsReportingRowObjectProviderV1({ storage: createFakeStorage() });
  const { nativeVersionRef } = await put(provider, 'adcp-rows/ns/big.jsonl', 'x'.repeat(64));
  await assert.rejects(
    provider.get({ ...base, objectRef: 'adcp-rows/ns/big.jsonl', nativeVersionRef, maxBytes: 10 }, signal()),
    isCode('ROWS_INTEGRITY_FAILED')
  );
  await assert.rejects(
    provider.get(
      {
        ...base,
        objectRef: 'adcp-rows/ns/big.jsonl',
        nativeVersionRef,
        range: { offset: 0, length: 20 },
        maxBytes: 10,
      },
      signal()
    ),
    isCode('ROWS_INTEGRITY_FAILED')
  );
  await assert.rejects(
    provider.get(
      {
        ...base,
        objectRef: 'adcp-rows/ns/big.jsonl',
        nativeVersionRef,
        range: { offset: 100, length: 4 },
        maxBytes: 10,
      },
      signal()
    ),
    isCode('ROWS_INTEGRITY_FAILED')
  );
});

test('delete targets the exact generation and is idempotent', async () => {
  const storage = createFakeStorage();
  const provider = createGcsReportingRowObjectProviderV1({ storage });
  const { nativeVersionRef } = await put(provider, 'adcp-rows/ns/d.jsonl');
  const key = 'adcp-rows/ns/d.jsonl';
  assert.equal(await provider.delete({ ...base, objectRef: key, nativeVersionRef: '17' }, signal()), 'absent');
  assert.equal(await provider.delete({ ...base, objectRef: key, nativeVersionRef: 'garbage' }, signal()), 'absent');
  assert.equal(await provider.delete({ ...base, objectRef: key, nativeVersionRef }, signal()), 'deleted');
  assert.equal(storage.calls.filter(call => call.op === 'delete').at(-1).generation, nativeVersionRef);
  assert.equal(await provider.delete({ ...base, objectRef: key, nativeVersionRef }, signal()), 'absent');
  storage.failures.delete = apiError(412);
  assert.equal(await provider.delete({ ...base, objectRef: key, nativeVersionRef }, signal()), 'absent');
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
  const { nativeVersionRef } = await put(provider, 'adcp-rows/ns/e.jsonl');
  storage.failures.createReadStream = apiError(500);
  await assert.rejects(
    provider.get({ ...base, objectRef: 'adcp-rows/ns/e.jsonl', nativeVersionRef, maxBytes: 100 }, signal()),
    error => isCode('PROVIDER_UNAVAILABLE')(error) && secretFree(error)
  );
  for (const code of [500, 403, 503]) {
    storage.failures['file.getMetadata'] = apiError(code);
    await assert.rejects(
      provider.stat({ ...base, objectRef: 'adcp-rows/ns/e.jsonl', nativeVersionRef }, signal()),
      error => isCode('PROVIDER_UNAVAILABLE')(error) && secretFree(error),
      String(code)
    );
  }
  storage.failures['file.getMetadata'] = apiError(404);
  assert.equal(
    await provider.stat({ ...base, objectRef: 'adcp-rows/ns/e.jsonl', nativeVersionRef }, signal()),
    null,
    'a 404 is the version being absent'
  );
  storage.failures.delete = apiError(403);
  await assert.rejects(
    provider.delete({ ...base, objectRef: 'adcp-rows/ns/e.jsonl', nativeVersionRef }, signal()),
    isCode('PROVIDER_UNAVAILABLE')
  );
});

test('deadlines and cancellation settle even when the client hangs', async t => {
  // AbortSignal.timeout uses an unreferenced timer; the inert client supplies
  // no active I/O to keep the event loop alive while that deadline expires.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
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
    {
      ...base,
      objectRef: 'adcp-rows/ns/h',
      bytes: Buffer.from('x'),
      contentType: 'application/x-ndjson',
      metadata: {},
    },
    { signal: controller.signal }
  );
  controller.abort();
  await assert.rejects(pending, isCode('ABORTED'));
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    provider.get({ ...base, objectRef: 'k', nativeVersionRef: '1', maxBytes: 1 }, { signal: aborted.signal }),
    isCode('ABORTED')
  );
});

test('stat reads only generation-pinned metadata', async () => {
  const storage = createFakeStorage();
  const provider = createGcsReportingRowObjectProviderV1({ storage });
  const { nativeVersionRef } = await put(provider, 'adcp-rows/ns/stat.jsonl', '0123456789');
  const mark = storage.calls.length;
  assert.deepEqual(await provider.stat({ ...base, objectRef: 'adcp-rows/ns/stat.jsonl', nativeVersionRef }, signal()), {
    nativeVersionRef,
    sizeBytes: 10,
  });
  const ops = storage.calls.slice(mark);
  assert.deepEqual(
    ops.map(call => call.op),
    ['file.getMetadata']
  );
  assert.equal(ops[0].generation, nativeVersionRef);
  for (const foreign of ['17', 'abc', '', '0']) {
    assert.equal(
      await provider.stat({ ...base, objectRef: 'adcp-rows/ns/stat.jsonl', nativeVersionRef: foreign }, signal()),
      null
    );
  }
  assert.equal(
    await provider.stat({ ...base, objectRef: 'adcp-rows/ns/missing.jsonl', nativeVersionRef }, signal()),
    null
  );
  await provider.delete({ ...base, objectRef: 'adcp-rows/ns/stat.jsonl', nativeVersionRef }, signal());
  assert.equal(
    await provider.stat({ ...base, objectRef: 'adcp-rows/ns/stat.jsonl', nativeVersionRef }, signal()),
    null
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
        const object = {
          generation: String(generation++),
          bytes: Buffer.from(media, 'latin1'),
          timeCreated: new Date().toISOString(),
        };
        objects.set(name, object);
        return json(200, { name, generation: object.generation, size: String(object.bytes.length) });
      }
      if (req.method === 'GET' && /^\/storage\/v1\/b\/[^/]+\/o$/.test(url.pathname)) {
        // Listing: names in order, paged by an offset token like the real API's opaque one.
        const prefix = url.searchParams.get('prefix') ?? '';
        const names = [...objects.keys()].filter(name => name.startsWith(prefix)).sort();
        const start = Number(url.searchParams.get('pageToken') ?? 0);
        const size = Number(url.searchParams.get('maxResults') ?? 1000);
        const page = names.slice(start, start + size);
        return json(200, {
          items: page.map(name => ({
            name,
            generation: objects.get(name).generation,
            size: String(objects.get(name).bytes.length),
            timeCreated: objects.get(name).timeCreated,
          })),
          ...(start + size < names.length ? { nextPageToken: String(start + size) } : {}),
        });
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
      if (url.searchParams.get('alt') !== 'media') {
        return json(200, { generation: object.generation, size: String(object.bytes.length) });
      }
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
    assert.equal(uploads.length, 6, 'three for the core checks and three for the listing checks');
    const listings = requests.filter(
      request => request.method === 'GET' && /\/o$/.test(request.url.pathname) && request.url.searchParams.has('prefix')
    );
    assert.ok(listings.length >= 4);
    assert.ok(listings.every(request => request.url.searchParams.get('versions') === 'true'));
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
