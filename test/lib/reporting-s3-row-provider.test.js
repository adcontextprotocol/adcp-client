/**
 * S3 row-object provider against an in-memory fake of the official
 * `S3Client.send(command, { abortSignal })` surface, using the real command
 * classes from `@aws-sdk/client-s3`.
 *
 * Opt-in emulator run (not in CI), e.g. with `moto_server -p 54500`:
 * REPORTING_S3_TEST_ENDPOINT=http://127.0.0.1:54500 node --test test/lib/reporting-s3-row-provider.test.js
 */
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { describe, test } = require('node:test');

const s3 = require('@aws-sdk/client-s3');
const { createS3ReportingRowObjectProviderV1 } = require('../../dist/lib/reporting/s3');
const {
  isReportingRowStoreError,
  runReportingRowObjectProviderConformanceV1,
} = require('../../dist/lib/reporting/ledger');

const SECRET = 'AKIAEXAMPLESECRETKEY';

function s3Error(status, name) {
  // Real service exceptions echo request IDs and resources; none of it may escape.
  return Object.assign(new Error(`${name}: arn:aws:s3:::rows-bucket credential=${SECRET}`), {
    name,
    $metadata: { httpStatusCode: status },
  });
}

function createFakeS3({
  versioned = false,
  ignoreIfNoneMatch = false,
  conditionalDeletes = true,
  conflictsBeforePut = 0,
  buckets = ['rows-bucket'],
  lifecycle,
  isPublic = false,
  region = 'us-east-1',
} = {}) {
  const store = new Map(); // key -> versions [{ versionId, etag, bytes, metadata, contentType }]
  const calls = [];
  const failures = {};
  let conflicts = conflictsBeforePut;
  let hang = false;
  const current = key => (store.get(key) ?? []).at(-1);
  const select = (key, input) => {
    if (input.VersionId !== undefined) {
      if (!versioned && input.VersionId !== 'null') throw s3Error(400, 'InvalidArgument');
      const version = (store.get(key) ?? []).find(item => item.versionId === input.VersionId);
      if (!version) throw s3Error(404, 'NoSuchVersion');
      return version;
    }
    const version = current(key);
    if (!version) throw s3Error(404, 'NoSuchKey');
    if (input.IfMatch !== undefined && input.IfMatch !== version.etag) throw s3Error(412, 'PreconditionFailed');
    return version;
  };
  const handlers = {
    HeadBucketCommand(input) {
      if (!buckets.includes(input.Bucket)) throw s3Error(404, 'NotFound');
      return {};
    },
    GetBucketPolicyStatusCommand() {
      return { PolicyStatus: { IsPublic: isPublic } };
    },
    GetBucketLifecycleConfigurationCommand() {
      if (!lifecycle) throw s3Error(404, 'NoSuchLifecycleConfiguration');
      return { Rules: lifecycle };
    },
    PutObjectCommand(input) {
      if (conflicts > 0) {
        conflicts--;
        throw s3Error(409, 'ConditionalRequestConflict');
      }
      if (input.IfNoneMatch === '*' && current(input.Key) && !ignoreIfNoneMatch) {
        throw s3Error(412, 'PreconditionFailed');
      }
      const bytes = Buffer.from(input.Body);
      const version = {
        versionId: versioned ? randomUUID() : undefined,
        etag: `"${createHash('md5').update(bytes).digest('hex')}"`,
        bytes,
        metadata: input.Metadata,
        contentType: input.ContentType,
      };
      store.set(input.Key, versioned ? [...(store.get(input.Key) ?? []), version] : [version]);
      return { ETag: version.etag, ...(versioned ? { VersionId: version.versionId } : {}) };
    },
    HeadObjectCommand(input) {
      let version;
      try {
        version = select(input.Key, input);
      } catch (error) {
        // HEAD responses have no body, so the SDK reports a bare NotFound.
        if (error.$metadata.httpStatusCode === 404) throw s3Error(404, 'NotFound');
        throw error;
      }
      return { ETag: version.etag, VersionId: version.versionId, ContentLength: version.bytes.length };
    },
    GetObjectCommand(input) {
      const version = select(input.Key, input);
      let bytes = version.bytes;
      if (input.Range) {
        const [, start, end] = input.Range.match(/^bytes=(\d+)-(\d+)$/);
        if (Number(start) >= bytes.length) throw s3Error(416, 'InvalidRange');
        bytes = bytes.subarray(Number(start), Number(end) + 1);
      }
      const parts = [];
      for (let offset = 0; offset < bytes.length; offset += 4) parts.push(bytes.subarray(offset, offset + 4));
      return {
        Body: Readable.from(parts),
        ContentLength: bytes.length,
        ETag: version.etag,
        VersionId: version.versionId,
      };
    },
    DeleteObjectCommand(input) {
      const versions = store.get(input.Key) ?? [];
      if (input.VersionId !== undefined) {
        store.set(
          input.Key,
          versions.filter(item => item.versionId !== input.VersionId)
        );
        return {};
      }
      if (input.IfMatch !== undefined) {
        if (!conditionalDeletes) throw s3Error(501, 'NotImplemented');
        const version = current(input.Key);
        if (!version) throw s3Error(404, 'NoSuchKey');
        if (version.etag !== input.IfMatch) throw s3Error(412, 'PreconditionFailed');
      }
      store.set(input.Key, versions.slice(0, -1));
      return {};
    },
  };
  const client = {
    calls,
    failures,
    store,
    config: { region: async () => region },
    set hang(value) {
      hang = value;
    },
    async send(command, options = {}) {
      const op = command.constructor.name;
      calls.push({ op, input: { ...command.input, Body: undefined }, abortSignal: options.abortSignal });
      if (hang) {
        return new Promise((_, reject) => {
          options.abortSignal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }))
          );
        });
      }
      if (failures[op]) {
        const error = failures[op];
        delete failures[op];
        throw error;
      }
      if (!handlers[op]) throw s3Error(501, 'NotImplemented');
      return handlers[op](command.input);
    },
  };
  return client;
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
  assert.doesNotMatch(error.message, /AKIA|arn:|credential/);
  return true;
};

for (const versioned of [false, true]) {
  test(`passes the shared provider conformance suite (${versioned ? 'versioned' : 'unversioned'})`, async () => {
    const client = createFakeS3({ versioned });
    const provider = createS3ReportingRowObjectProviderV1({ client });
    const passed = await runReportingRowObjectProviderConformanceV1(provider, { ...base, prefix: 'adcp-rows' });
    assert.deepEqual(passed, [
      'probe',
      'create',
      'create-only',
      'ranged-read',
      'version-pinned-read',
      'exact-version-delete',
    ]);
    assert.equal(client.store.size === 0 || [...client.store.values()].every(v => v.length === 0), true);
    assert.ok(client.calls.every(call => call.abortSignal instanceof AbortSignal));
  });
}

test('create-only put sends If-None-Match and records VersionId or quoted ETag', async () => {
  const unversioned = createFakeS3();
  const provider = createS3ReportingRowObjectProviderV1({ client: unversioned });
  const created = await put(provider, 'adcp-rows/ns/a.jsonl.gz');
  assert.equal(created.created, true);
  assert.match(created.nativeVersion, /^"[0-9a-f]{32}"$/);
  const call = unversioned.calls.find(item => item.op === 'PutObjectCommand');
  assert.equal(call.input.IfNoneMatch, '*');
  assert.equal(call.input.ContentType, 'application/gzip');
  assert.equal(call.input.ContentEncoding, undefined);
  assert.deepEqual(call.input.Metadata, { 'adcp-installation': 'inst', 'adcp-intent': 'intent' });

  const versioned = createFakeS3({ versioned: true });
  const versionedProvider = createS3ReportingRowObjectProviderV1({ client: versioned });
  const v = await put(versionedProvider, 'adcp-rows/ns/a.jsonl.gz');
  assert.match(v.nativeVersion, /^[0-9a-f-]{36}$/);
});

test('412 adopts the existing version; 409 is retried once', async () => {
  const client = createFakeS3({ versioned: true });
  const provider = createS3ReportingRowObjectProviderV1({ client });
  const first = await put(provider, 'adcp-rows/ns/a.jsonl', 'first\n');
  assert.deepEqual(await put(provider, 'adcp-rows/ns/a.jsonl', 'second\n'), {
    created: false,
    nativeVersion: first.nativeVersion,
  });
  const bytes = await provider.get(
    { ...base, key: 'adcp-rows/ns/a.jsonl', nativeVersion: first.nativeVersion, maxBytes: 100 },
    signal()
  );
  assert.equal(Buffer.from(bytes).toString(), 'first\n');

  const retried = createFakeS3({ conflictsBeforePut: 1 });
  const ok = await put(createS3ReportingRowObjectProviderV1({ client: retried }), 'adcp-rows/ns/r.jsonl');
  assert.equal(ok.created, true);
  assert.equal(retried.calls.filter(item => item.op === 'PutObjectCommand').length, 2);

  const twice = createFakeS3({ conflictsBeforePut: 2 });
  await assert.rejects(put(createS3ReportingRowObjectProviderV1({ client: twice }), 'adcp-rows/ns/r.jsonl'), error => {
    assert.ok(isCode('PROVIDER_UNAVAILABLE')(error));
    return secretFree(error);
  });
});

test('reads pin VersionId or If-Match and honour ranges and the byte cap', async () => {
  for (const versioned of [false, true]) {
    const client = createFakeS3({ versioned });
    const provider = createS3ReportingRowObjectProviderV1({ client });
    const key = 'adcp-rows/ns/r.jsonl';
    const { nativeVersion } = await put(provider, key, '0123456789abcdef');
    const ranged = await provider.get(
      { ...base, key, nativeVersion, range: { offset: 4, length: 6 }, maxBytes: 6 },
      signal()
    );
    assert.equal(Buffer.from(ranged).toString(), '456789');
    const call = client.calls.filter(item => item.op === 'GetObjectCommand').at(-1);
    assert.equal(call.input.Range, 'bytes=4-9');
    if (versioned) assert.equal(call.input.VersionId, nativeVersion);
    else assert.equal(call.input.IfMatch, nativeVersion);

    assert.equal(await provider.get({ ...base, key, nativeVersion: '"0000"', maxBytes: 100 }, signal()), null);
    assert.equal(await provider.get({ ...base, key, nativeVersion: 'not-a-version', maxBytes: 100 }, signal()), null);
    assert.equal(await provider.get({ ...base, key, nativeVersion: 'bad version', maxBytes: 100 }, signal()), null);
    assert.equal(
      await provider.get({ ...base, key: 'adcp-rows/ns/missing', nativeVersion, maxBytes: 100 }, signal()),
      null
    );
    await assert.rejects(
      provider.get({ ...base, key, nativeVersion, maxBytes: 8 }, signal()),
      isCode('ROWS_INTEGRITY_FAILED')
    );
    await assert.rejects(
      provider.get({ ...base, key, nativeVersion, range: { offset: 99, length: 2 }, maxBytes: 8 }, signal()),
      isCode('ROWS_INTEGRITY_FAILED')
    );
    const empty = await provider.get(
      { ...base, key, nativeVersion, range: { offset: 2, length: 0 }, maxBytes: 0 },
      signal()
    );
    assert.equal(empty.length, 0);
  }
});

test('a store that ignores versionId or If-Match never serves or deletes a different version', async () => {
  const client = createFakeS3();
  const provider = createS3ReportingRowObjectProviderV1({ client });
  const key = 'adcp-rows/ns/v.jsonl';
  const { nativeVersion } = await put(provider, key);
  const send = client.send.bind(client);
  client.send = (command, options) => {
    // Emulate a store that drops the version selectors and answers from the current object.
    delete command.input.VersionId;
    delete command.input.IfMatch;
    return send(command, options);
  };
  for (const foreign of ['"0000"', 'some-version']) {
    assert.equal(await provider.get({ ...base, key, nativeVersion: foreign, maxBytes: 100 }, signal()), null);
    assert.equal(
      await provider.get(
        { ...base, key, nativeVersion: foreign, range: { offset: 0, length: 0 }, maxBytes: 0 },
        signal()
      ),
      null
    );
    assert.equal(await provider.delete({ ...base, key, nativeVersion: foreign }, signal()), 'absent');
  }
  assert.ok(await provider.get({ ...base, key, nativeVersion, maxBytes: 100 }, signal()));
});

test('streaming cap applies even when ContentLength is absent', async () => {
  const client = createFakeS3();
  const provider = createS3ReportingRowObjectProviderV1({ client });
  const { nativeVersion } = await put(provider, 'adcp-rows/ns/big.jsonl', 'x'.repeat(64));
  const send = client.send.bind(client);
  client.send = async (command, options) => {
    const output = await send(command, options);
    if (command.constructor.name === 'GetObjectCommand') delete output.ContentLength;
    return output;
  };
  await assert.rejects(
    provider.get({ ...base, key: 'adcp-rows/ns/big.jsonl', nativeVersion, maxBytes: 10 }, signal()),
    isCode('ROWS_INTEGRITY_FAILED')
  );
});

test('delete removes only the exact version and is idempotent', async () => {
  for (const versioned of [false, true]) {
    const client = createFakeS3({ versioned });
    const provider = createS3ReportingRowObjectProviderV1({ client });
    const key = 'adcp-rows/ns/d.jsonl';
    const { nativeVersion } = await put(provider, key);
    assert.equal(await provider.delete({ ...base, key, nativeVersion: '"0000"' }, signal()), 'absent');
    assert.equal(await provider.delete({ ...base, key, nativeVersion: 'not-a-version' }, signal()), 'absent');
    assert.equal(client.store.get(key).length, 1);
    assert.equal(await provider.delete({ ...base, key, nativeVersion }, signal()), 'deleted');
    const deletes = client.calls.filter(item => item.op === 'DeleteObjectCommand');
    if (versioned) assert.equal(deletes.at(-1).input.VersionId, nativeVersion);
    else assert.equal(deletes.at(-1).input.IfMatch, nativeVersion);
    assert.equal(await provider.delete({ ...base, key, nativeVersion }, signal()), 'absent');
  }
  // Stores without conditional deletes fall back to HEAD-compare then delete.
  const legacy = createFakeS3({ conditionalDeletes: false });
  const provider = createS3ReportingRowObjectProviderV1({ client: legacy });
  const { nativeVersion } = await put(provider, 'adcp-rows/ns/l.jsonl');
  assert.equal(await provider.delete({ ...base, key: 'adcp-rows/ns/l.jsonl', nativeVersion }, signal()), 'deleted');
  assert.equal(legacy.store.get('adcp-rows/ns/l.jsonl').length, 0);
});

test('probe refuses unsafe buckets and stores that ignore If-None-Match', async () => {
  const probe = (client, location = base.location) =>
    createS3ReportingRowObjectProviderV1({ client }).probe({ location, prefix: 'adcp-rows' }, signal());
  const safe = createFakeS3();
  await probe(safe);
  assert.equal([...safe.store.values()].flat().length, 0, 'probe objects are cleaned up');
  const versioned = createFakeS3({ versioned: true });
  await probe(versioned);
  assert.equal([...versioned.store.values()].flat().length, 0);

  const ignoring = createFakeS3({ ignoreIfNoneMatch: true, versioned: true });
  await assert.rejects(probe(ignoring), error => {
    assert.ok(isCode('UNSAFE_BINDING')(error));
    assert.match(error.message, /If-None-Match/);
    return secretFree(error);
  });
  assert.equal([...ignoring.store.values()].flat().length, 0, 'both probe versions are cleaned up');

  await assert.rejects(probe(createFakeS3({ buckets: [] })), isCode('UNSAFE_BINDING'));
  const forbidden = createFakeS3();
  forbidden.failures.HeadBucketCommand = s3Error(403, 'Forbidden');
  await assert.rejects(probe(forbidden), isCode('UNSAFE_BINDING'));
  await assert.rejects(probe(createFakeS3({ isPublic: true })), isCode('UNSAFE_BINDING'));
  await assert.rejects(
    probe(createFakeS3({ region: 'eu-west-1' }), { bucket: 'rows-bucket', region: 'us-east-1' }),
    isCode('UNSAFE_BINDING')
  );
  await probe(createFakeS3({ region: 'eu-west-1' }), { bucket: 'rows-bucket', region: 'eu-west-1' });
  const lifecycleForbidden = createFakeS3();
  lifecycleForbidden.failures.GetBucketLifecycleConfigurationCommand = s3Error(403, 'AccessDenied');
  await assert.rejects(probe(lifecycleForbidden), isCode('UNSAFE_BINDING'));
  const noPolicyApi = createFakeS3();
  noPolicyApi.failures.GetBucketPolicyStatusCommand = s3Error(501, 'NotImplemented');
  await probe(noPolicyApi);

  const unsafeRules = [
    [{ Status: 'Enabled', Expiration: { Days: 30 }, Filter: {} }],
    [{ Status: 'Enabled', Expiration: { Days: 30 }, Filter: { Prefix: 'adcp' } }],
    [{ Status: 'Enabled', Expiration: { Date: new Date() }, Filter: { And: { Prefix: 'adcp-rows/ns/' } } }],
    [{ Status: 'Enabled', Expiration: { Days: 1 }, Prefix: '' }],
  ];
  for (const lifecycle of unsafeRules) {
    await assert.rejects(probe(createFakeS3({ lifecycle })), isCode('UNSAFE_BINDING'));
  }
  const allowedRules = [
    [{ Status: 'Disabled', Expiration: { Days: 30 }, Filter: {} }],
    [{ Status: 'Enabled', Expiration: { Days: 30 }, Filter: { Prefix: 'tmp/' } }],
    [{ Status: 'Enabled', Expiration: { ExpiredObjectDeleteMarker: true }, Filter: {} }],
    [{ Status: 'Enabled', NoncurrentVersionExpiration: { NoncurrentDays: 7 }, Filter: {} }],
    [{ Status: 'Enabled', AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 }, Filter: {} }],
    [{ Status: 'Enabled', Expiration: { Days: 30 }, Filter: { Tag: { Key: 'tmp', Value: '1' } } }],
  ];
  for (const lifecycle of allowedRules) await probe(createFakeS3({ lifecycle }));
});

test('credentialRef selects from a closed client map; locations never carry endpoints', async () => {
  const primary = createFakeS3();
  const tenant = createFakeS3();
  const provider = createS3ReportingRowObjectProviderV1({ client: primary, clients: { tenant } });
  await put(provider, 'adcp-rows/ns/default.jsonl');
  await put(provider, 'adcp-rows/ns/tenant.jsonl', 'x', { credentialRef: 'tenant' });
  assert.equal(primary.calls.length, 1);
  assert.equal(tenant.calls.length, 1);
  await assert.rejects(put(provider, 'adcp-rows/ns/x.jsonl', 'x', { credentialRef: 'nope' }), error => {
    assert.ok(isCode('UNSAFE_BINDING')(error));
    assert.doesNotMatch(error.message, /nope/);
    return true;
  });
  provider.validateLocation({ bucket: 'rows-bucket' });
  provider.validateLocation({ bucket: 'rows-bucket', region: 'auto' });
  for (const location of [
    {},
    { bucket: 'Rows' },
    { bucket: '192.168.0.1' },
    { bucket: 'rows-bucket', endpoint: 'https://evil.example' },
    { bucket: 'rows-bucket', region: 'us east' },
    { bucket: 'rows-bucket', secretAccessKey: SECRET },
  ]) {
    assert.throws(() => provider.validateLocation(location), isCode('INVALID_INPUT'));
  }
  assert.throws(() => createS3ReportingRowObjectProviderV1({}), isCode('INVALID_INPUT'));
  assert.throws(() => createS3ReportingRowObjectProviderV1({ client: {} }), isCode('INVALID_INPUT'));
});

test('provider errors map to stable, secret-free codes', async () => {
  const client = createFakeS3();
  const provider = createS3ReportingRowObjectProviderV1({ client });
  client.failures.PutObjectCommand = s3Error(500, 'InternalError');
  await assert.rejects(put(provider, 'adcp-rows/ns/e.jsonl'), error => {
    assert.ok(isCode('PROVIDER_UNAVAILABLE')(error));
    return secretFree(error);
  });
  const { nativeVersion } = await put(provider, 'adcp-rows/ns/e.jsonl');
  client.failures.GetObjectCommand = s3Error(403, 'AccessDenied');
  await assert.rejects(
    provider.get({ ...base, key: 'adcp-rows/ns/e.jsonl', nativeVersion, maxBytes: 100 }, signal()),
    error => isCode('PROVIDER_UNAVAILABLE')(error) && secretFree(error)
  );
  client.failures.HeadObjectCommand = s3Error(503, 'SlowDown');
  await assert.rejects(
    provider.delete({ ...base, key: 'adcp-rows/ns/e.jsonl', nativeVersion }, signal()),
    isCode('PROVIDER_UNAVAILABLE')
  );
});

test('deadlines and cancellation propagate as abortSignal and stable codes', async () => {
  const client = createFakeS3();
  client.hang = true;
  const provider = createS3ReportingRowObjectProviderV1({ client });
  await assert.rejects(
    provider.probe({ ...base, prefix: 'adcp-rows' }, { signal: AbortSignal.timeout(20) }),
    isCode('DEADLINE_EXCEEDED')
  );
  const controller = new AbortController();
  const pending = provider.get(
    { ...base, key: 'adcp-rows/ns/x', nativeVersion: '"abc"', maxBytes: 10 },
    { signal: controller.signal }
  );
  controller.abort();
  await assert.rejects(pending, isCode('ABORTED'));
  assert.ok(client.calls.every(call => call.abortSignal instanceof AbortSignal));
});

const ENDPOINT = process.env.REPORTING_S3_TEST_ENDPOINT;
describe('S3-compatible emulator', { skip: !ENDPOINT && 'REPORTING_S3_TEST_ENDPOINT not set' }, () => {
  test('conformance against a real endpoint with the official client', async () => {
    const client = new s3.S3Client({
      endpoint: ENDPOINT,
      region: process.env.REPORTING_S3_TEST_REGION ?? 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.REPORTING_S3_TEST_ACCESS_KEY ?? 'testing',
        secretAccessKey: process.env.REPORTING_S3_TEST_SECRET_KEY ?? 'testing',
      },
    });
    const provider = createS3ReportingRowObjectProviderV1({ client });
    for (const versioned of [false, true]) {
      const Bucket = `adcp-rows-${versioned ? 'v' : 'u'}-${process.pid}`;
      await client.send(new s3.CreateBucketCommand({ Bucket })).catch(() => undefined);
      if (versioned) {
        await client.send(
          new s3.PutBucketVersioningCommand({ Bucket, VersioningConfiguration: { Status: 'Enabled' } })
        );
      }
      const location = { bucket: Bucket };
      const passed = await runReportingRowObjectProviderConformanceV1(provider, { location, prefix: 'adcp-rows' });
      assert.equal(passed.length, 6);
      const created = await provider.putIfAbsent(
        {
          location,
          key: 'adcp-rows/ns/emulator.jsonl',
          bytes: Buffer.from('{"a":1}\n'),
          contentType: 'application/x-ndjson',
          metadata: { 'adcp-installation': 'emulator' },
        },
        signal()
      );
      if (versioned) assert.doesNotMatch(created.nativeVersion, /^"/);
      else assert.match(created.nativeVersion, /^"/);
      const foreign = versioned ? created.nativeVersion.replace(/.$/, c => (c === 'a' ? 'b' : 'a')) : '"0000"';
      const pinned = { location, key: 'adcp-rows/ns/emulator.jsonl' };
      assert.equal(await provider.get({ ...pinned, nativeVersion: foreign, maxBytes: 100 }, signal()), null);
      assert.equal(await provider.delete({ ...pinned, nativeVersion: foreign }, signal()), 'absent');
      assert.equal(
        await provider.delete(
          { location, key: 'adcp-rows/ns/emulator.jsonl', nativeVersion: created.nativeVersion },
          signal()
        ),
        'deleted'
      );
    }
  });
});
