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
const { createS3ReportingRowObjectProviderV1 } = require('@adcp/reporting-storage/s3');
const { isReportingRowStoreError, runReportingRowObjectProviderConformanceV1 } = require('./helpers/ledger.js');

const SECRET = 'AKIAEXAMPLESECRETKEY';

function s3Error(status, name) {
  // Real service exceptions echo request IDs and resources; none of it may escape.
  return Object.assign(new Error(`${name}: arn:aws:s3:::rows-bucket credential=${SECRET}`), {
    name,
    $metadata: { httpStatusCode: status },
  });
}

function createFakeS3({
  versioned = true,
  versioningStatus = versioned ? 'Enabled' : undefined,
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
    GetBucketVersioningCommand() {
      return versioningStatus ? { Status: versioningStatus } : {};
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
        lastModified: new Date(),
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
    ListObjectVersionsCommand(input) {
      const entries = [];
      for (const [key, versions] of [...store.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        if (!key.startsWith(input.Prefix ?? '')) continue;
        versions.forEach((version, index) =>
          entries.push({
            Key: key,
            VersionId: version.versionId ?? 'null',
            IsLatest: index === versions.length - 1,
            LastModified: version.lastModified,
            Size: version.bytes.length,
          })
        );
      }
      const start =
        input.KeyMarker === undefined
          ? 0
          : entries.findIndex(item => item.Key === input.KeyMarker && item.VersionId === input.VersionIdMarker) + 1;
      const page = entries.slice(start, start + (input.MaxKeys ?? 1000));
      const truncated = start + page.length < entries.length;
      const last = page.at(-1);
      return {
        Versions: page,
        // Delete markers are listed separately and are never objects.
        DeleteMarkers: [{ Key: `${input.Prefix ?? ''}marker`, VersionId: 'dm', IsLatest: true }],
        IsTruncated: truncated,
        ...(truncated ? { NextKeyMarker: last.Key, NextVersionIdMarker: last.VersionId } : {}),
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
  assert.doesNotMatch(error.message, /AKIA|arn:|credential/);
  return true;
};

test('passes the shared provider conformance suite', async () => {
  const client = createFakeS3();
  const provider = createS3ReportingRowObjectProviderV1({ client });
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
  assert.equal(client.store.size === 0 || [...client.store.values()].every(v => v.length === 0), true);
  assert.ok(client.calls.every(call => call.abortSignal instanceof AbortSignal));
});

test('list pages through every version, noncurrent ones included, and skips delete markers', async () => {
  const client = createFakeS3();
  const provider = createS3ReportingRowObjectProviderV1({ client });
  const a = await put(provider, 'adcp-rows/ns/a.jsonl', 'aa\n');
  const b = await put(provider, 'adcp-rows/ns/b.jsonl', 'bbb\n');
  await put(provider, 'adcp-rows/other/c.jsonl');
  // A noncurrent version at the same key.
  client.store.get('adcp-rows/ns/b.jsonl').push({
    versionId: 'second-version',
    bytes: Buffer.from('b2\n'),
    lastModified: new Date(),
  });
  const seen = [];
  let pageToken;
  let pages = 0;
  do {
    const page = await provider.list(
      { ...base, prefix: 'adcp-rows/ns/', pageSize: 2, ...(pageToken ? { pageToken } : {}) },
      signal()
    );
    assert.ok(page.objects.length <= 2);
    seen.push(...page.objects);
    pageToken = page.nextPageToken;
    pages += 1;
  } while (pageToken);
  assert.equal(pages, 2);
  assert.deepEqual(
    seen.map(entry => [entry.objectRef, entry.nativeVersionRef, entry.sizeBytes]),
    [
      ['adcp-rows/ns/a.jsonl', a.nativeVersionRef, 3],
      ['adcp-rows/ns/b.jsonl', b.nativeVersionRef, 4],
      ['adcp-rows/ns/b.jsonl', 'second-version', 3],
    ]
  );
  assert.ok(seen.every(entry => Number.isFinite(Date.parse(entry.createdAt))));
  const call = client.calls.filter(item => item.op === 'ListObjectVersionsCommand')[0];
  assert.equal(call.input.Prefix, 'adcp-rows/ns/');
  assert.equal(call.input.MaxKeys, 2);
  assert.ok(call.abortSignal instanceof AbortSignal);
});

test('list leaves out an entry it cannot age, and refuses a truncated listing that has no marker', async () => {
  const client = createFakeS3();
  const provider = createS3ReportingRowObjectProviderV1({ client });
  const good = await put(provider, 'adcp-rows/ns/good.jsonl');
  client.store.set('adcp-rows/ns/bad-time.jsonl', [
    { versionId: 'bad-time-version', bytes: Buffer.from('x'), lastModified: 'not a date' },
  ]);
  const page = await provider.list({ ...base, prefix: 'adcp-rows/ns/', pageSize: 10 }, signal());
  assert.deepEqual(
    page.objects.map(entry => entry.nativeVersionRef),
    [good.nativeVersionRef]
  );
  assert.equal(page.skipped, 1, 'what it left out is counted');
  const send = client.send.bind(client);
  client.send = async (command, options) =>
    command.constructor.name === 'ListObjectVersionsCommand'
      ? { Versions: [], IsTruncated: true }
      : send(command, options);
  await assert.rejects(
    () => provider.list({ ...base, prefix: 'adcp-rows/ns/', pageSize: 10 }, signal()),
    isCode('PROVIDER_UNAVAILABLE')
  );
});

test('list rejects a forged page token and a bad page size, and skips unversioned objects', async () => {
  const unversioned = createFakeS3({ versioned: false });
  const provider = createS3ReportingRowObjectProviderV1({ client: unversioned });
  unversioned.store.set('adcp-rows/ns/old.jsonl', [{ bytes: Buffer.from('x'), lastModified: new Date() }]);
  assert.deepEqual((await provider.list({ ...base, prefix: 'adcp-rows/ns/', pageSize: 10 }, signal())).objects, []);
  await assert.rejects(
    () => provider.list({ ...base, prefix: 'adcp-rows/ns/', pageSize: 10, pageToken: 'not-a-token' }, signal()),
    isCode('INVALID_INPUT')
  );
  await assert.rejects(
    () => provider.list({ ...base, prefix: 'adcp-rows/ns/', pageSize: 0 }, signal()),
    isCode('INVALID_INPUT')
  );
});

test('create-only put sends If-None-Match and records the VersionId', async () => {
  const client = createFakeS3();
  const provider = createS3ReportingRowObjectProviderV1({ client });
  const created = await put(provider, 'adcp-rows/ns/a.jsonl.gz');
  assert.equal(created.created, true);
  assert.match(created.nativeVersionRef, /^[0-9a-f-]{36}$/);
  const call = client.calls.find(item => item.op === 'PutObjectCommand');
  assert.equal(call.input.IfNoneMatch, '*');
  assert.equal(call.input.ContentType, 'application/gzip');
  assert.equal(call.input.ContentEncoding, undefined);
  assert.deepEqual(call.input.Metadata, { 'adcp-installation': 'inst', 'adcp-intent': 'intent' });
});

test('writes and adoption refuse results without a VersionId (never fall back to the ETag)', async () => {
  const unversioned = createFakeS3({ versioned: false });
  const provider = createS3ReportingRowObjectProviderV1({ client: unversioned });
  await assert.rejects(put(provider, 'adcp-rows/ns/a.jsonl'), error => {
    assert.ok(isCode('UNSAFE_BINDING')(error));
    assert.match(error.message, /versioning must be enabled/);
    return secretFree(error);
  });
  // The key exists now: the 412 adopt path must refuse too.
  await assert.rejects(put(provider, 'adcp-rows/ns/a.jsonl'), isCode('UNSAFE_BINDING'));
  // The literal `null` version of an object written before versioning is not write-unique.
  const nullVersion = createFakeS3();
  const send = nullVersion.send.bind(nullVersion);
  nullVersion.send = async (command, options) => {
    const output = await send(command, options);
    return command.constructor.name === 'PutObjectCommand' ? { ...output, VersionId: 'null' } : output;
  };
  await assert.rejects(
    put(createS3ReportingRowObjectProviderV1({ client: nullVersion }), 'adcp-rows/ns/n.jsonl'),
    isCode('UNSAFE_BINDING')
  );
  const key = 'adcp-rows/ns/a.jsonl';
  assert.equal(await provider.get({ ...base, objectRef: key, nativeVersionRef: 'null', maxBytes: 9 }, signal()), null);
  assert.equal(await provider.delete({ ...base, objectRef: key, nativeVersionRef: 'null' }, signal()), 'absent');
  assert.equal(
    await provider.get({ ...base, objectRef: key, nativeVersionRef: '"0123"', maxBytes: 9 }, signal()),
    null,
    'quoted ETags are no longer versions'
  );
});

test('412 adopts the existing version; 409 is retried once', async () => {
  const client = createFakeS3({ versioned: true });
  const provider = createS3ReportingRowObjectProviderV1({ client });
  const first = await put(provider, 'adcp-rows/ns/a.jsonl', 'first\n');
  assert.deepEqual(await put(provider, 'adcp-rows/ns/a.jsonl', 'second\n'), {
    created: false,
    nativeVersionRef: first.nativeVersionRef,
  });
  const bytes = await provider.get(
    { ...base, objectRef: 'adcp-rows/ns/a.jsonl', nativeVersionRef: first.nativeVersionRef, maxBytes: 100 },
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

test('reads pin VersionId and honour ranges and the byte cap', async () => {
  {
    const client = createFakeS3();
    const provider = createS3ReportingRowObjectProviderV1({ client });
    const key = 'adcp-rows/ns/r.jsonl';
    const { nativeVersionRef } = await put(provider, key, '0123456789abcdef');
    const ranged = await provider.get(
      { ...base, objectRef: key, nativeVersionRef, range: { offset: 4, length: 6 }, maxBytes: 6 },
      signal()
    );
    assert.equal(Buffer.from(ranged).toString(), '456789');
    const call = client.calls.filter(item => item.op === 'GetObjectCommand').at(-1);
    assert.equal(call.input.Range, 'bytes=4-9');
    assert.equal(call.input.VersionId, nativeVersionRef);
    assert.equal(call.input.IfMatch, undefined);

    assert.equal(
      await provider.get({ ...base, objectRef: key, nativeVersionRef: '"0000"', maxBytes: 100 }, signal()),
      null
    );
    assert.equal(
      await provider.get({ ...base, objectRef: key, nativeVersionRef: 'not-a-version', maxBytes: 100 }, signal()),
      null
    );
    assert.equal(
      await provider.get({ ...base, objectRef: key, nativeVersionRef: 'bad version', maxBytes: 100 }, signal()),
      null
    );
    assert.equal(
      await provider.get({ ...base, objectRef: 'adcp-rows/ns/missing', nativeVersionRef, maxBytes: 100 }, signal()),
      null
    );
    await assert.rejects(
      provider.get({ ...base, objectRef: key, nativeVersionRef, maxBytes: 8 }, signal()),
      isCode('ROWS_INTEGRITY_FAILED')
    );
    await assert.rejects(
      provider.get(
        { ...base, objectRef: key, nativeVersionRef, range: { offset: 99, length: 2 }, maxBytes: 8 },
        signal()
      ),
      isCode('ROWS_INTEGRITY_FAILED')
    );
    const empty = await provider.get(
      { ...base, objectRef: key, nativeVersionRef, range: { offset: 2, length: 0 }, maxBytes: 0 },
      signal()
    );
    assert.equal(empty.length, 0);
  }
});

test('a store that ignores VersionId never serves or deletes a different version', async () => {
  const client = createFakeS3();
  const provider = createS3ReportingRowObjectProviderV1({ client });
  const key = 'adcp-rows/ns/v.jsonl';
  const { nativeVersionRef } = await put(provider, key);
  const send = client.send.bind(client);
  client.send = (command, options) => {
    // Emulate a store that drops the version selectors and answers from the current object.
    delete command.input.VersionId;
    return send(command, options);
  };
  for (const foreign of ['other-version', 'some-version']) {
    assert.equal(
      await provider.get({ ...base, objectRef: key, nativeVersionRef: foreign, maxBytes: 100 }, signal()),
      null
    );
    assert.equal(
      await provider.get(
        { ...base, objectRef: key, nativeVersionRef: foreign, range: { offset: 0, length: 0 }, maxBytes: 0 },
        signal()
      ),
      null
    );
    assert.equal(await provider.delete({ ...base, objectRef: key, nativeVersionRef: foreign }, signal()), 'absent');
  }
  assert.ok(await provider.get({ ...base, objectRef: key, nativeVersionRef, maxBytes: 100 }, signal()));
});

test('stat proves one exact version and its size with a HEAD, never a body read', async () => {
  const client = createFakeS3();
  const provider = createS3ReportingRowObjectProviderV1({ client });
  const key = 'adcp-rows/ns/stat.jsonl';
  const { nativeVersionRef } = await put(provider, key, '0123456789');
  const mark = client.calls.length;
  assert.deepEqual(await provider.stat({ ...base, objectRef: key, nativeVersionRef }, signal()), {
    nativeVersionRef,
    sizeBytes: 10,
  });
  assert.deepEqual(
    client.calls.slice(mark).map(call => call.op),
    ['HeadObjectCommand']
  );
  assert.equal(client.calls.at(-1).input.VersionId, nativeVersionRef);
  for (const foreign of ['null', 'not-a-version', 'bad version', '"0000"', '']) {
    assert.equal(await provider.stat({ ...base, objectRef: key, nativeVersionRef: foreign }, signal()), null);
  }
  assert.equal(await provider.stat({ ...base, objectRef: 'adcp-rows/ns/missing', nativeVersionRef }, signal()), null);
  // A store that drops the version selector answers from the current object; only an echoed version counts.
  const send = client.send.bind(client);
  client.send = (command, options) => {
    delete command.input.VersionId;
    return send(command, options);
  };
  assert.equal(await provider.stat({ ...base, objectRef: key, nativeVersionRef: 'other-version' }, signal()), null);
  client.send = send;
  await provider.delete({ ...base, objectRef: key, nativeVersionRef }, signal());
  assert.equal(await provider.stat({ ...base, objectRef: key, nativeVersionRef }, signal()), null);
});

test('streaming cap applies even when ContentLength is absent', async () => {
  const client = createFakeS3();
  const provider = createS3ReportingRowObjectProviderV1({ client });
  const { nativeVersionRef } = await put(provider, 'adcp-rows/ns/big.jsonl', 'x'.repeat(64));
  const send = client.send.bind(client);
  client.send = async (command, options) => {
    const output = await send(command, options);
    if (command.constructor.name === 'GetObjectCommand') delete output.ContentLength;
    return output;
  };
  await assert.rejects(
    provider.get({ ...base, objectRef: 'adcp-rows/ns/big.jsonl', nativeVersionRef, maxBytes: 10 }, signal()),
    isCode('ROWS_INTEGRITY_FAILED')
  );
});

test('delete removes only the exact version and is idempotent', async () => {
  const client = createFakeS3();
  const provider = createS3ReportingRowObjectProviderV1({ client });
  const key = 'adcp-rows/ns/d.jsonl';
  const { nativeVersionRef } = await put(provider, key);
  assert.equal(await provider.delete({ ...base, objectRef: key, nativeVersionRef: '"0000"' }, signal()), 'absent');
  assert.equal(
    await provider.delete({ ...base, objectRef: key, nativeVersionRef: 'not-a-version' }, signal()),
    'absent'
  );
  assert.equal(client.store.get(key).length, 1);
  assert.equal(await provider.delete({ ...base, objectRef: key, nativeVersionRef }, signal()), 'deleted');
  const deletes = client.calls.filter(item => item.op === 'DeleteObjectCommand');
  assert.equal(deletes.at(-1).input.VersionId, nativeVersionRef);
  assert.equal(deletes.at(-1).input.IfMatch, undefined);
  assert.equal(client.store.get(key).length, 0, 'deleting a VersionId removes the version without a delete marker');
  assert.equal(await provider.delete({ ...base, objectRef: key, nativeVersionRef }, signal()), 'absent');
});

test('a delayed delete of an old version never removes an identical re-creation', async () => {
  const client = createFakeS3();
  const provider = createS3ReportingRowObjectProviderV1({ client });
  const key = 'adcp-rows/ns/fence.jsonl';
  const first = await put(provider, key, 'same bytes\n');
  assert.equal(
    await provider.delete({ ...base, objectRef: key, nativeVersionRef: first.nativeVersionRef }, signal()),
    'deleted'
  );
  const second = await put(provider, key, 'same bytes\n');
  assert.equal(second.created, true);
  assert.notEqual(second.nativeVersionRef, first.nativeVersionRef);
  assert.equal(
    await provider.delete({ ...base, objectRef: key, nativeVersionRef: first.nativeVersionRef }, signal()),
    'absent'
  );
  const bytes = await provider.get(
    { ...base, objectRef: key, nativeVersionRef: second.nativeVersionRef, maxBytes: 100 },
    signal()
  );
  assert.equal(Buffer.from(bytes).toString(), 'same bytes\n');
  assert.equal(client.store.get(key).length, 1);
});

test('probe refuses unsafe buckets and stores that ignore If-None-Match', async () => {
  const probe = (client, location = base.location) =>
    createS3ReportingRowObjectProviderV1({ client }).probe({ location, prefix: 'adcp-rows' }, signal());
  const safe = createFakeS3();
  await probe(safe);
  assert.equal([...safe.store.values()].flat().length, 0, 'probe objects are cleaned up');
  for (const versioningStatus of [undefined, 'Suspended']) {
    const unversioned = createFakeS3({ versioned: false, versioningStatus });
    await assert.rejects(probe(unversioned), error => {
      assert.ok(isCode('UNSAFE_BINDING')(error));
      assert.match(error.message, /versioning must be enabled/);
      return secretFree(error);
    });
    assert.equal(
      unversioned.calls.some(call => call.op === 'PutObjectCommand'),
      false,
      'no probe writes happen on an unversioned bucket'
    );
  }
  const versioningDenied = createFakeS3();
  versioningDenied.failures.GetBucketVersioningCommand = s3Error(403, 'AccessDenied');
  await assert.rejects(probe(versioningDenied), isCode('UNSAFE_BINDING'));
  // A store that reports versioning Enabled but returns no VersionId on writes is refused by the probe write.
  const lying = createFakeS3({ versioned: false, versioningStatus: 'Enabled' });
  await assert.rejects(probe(lying), isCode('UNSAFE_BINDING'));
  assert.equal([...lying.store.values()].flat().length, 0, 'probe objects are cleaned up when refused');

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
  const { nativeVersionRef } = await put(provider, 'adcp-rows/ns/e.jsonl');
  client.failures.GetObjectCommand = s3Error(403, 'AccessDenied');
  await assert.rejects(
    provider.get({ ...base, objectRef: 'adcp-rows/ns/e.jsonl', nativeVersionRef, maxBytes: 100 }, signal()),
    error => isCode('PROVIDER_UNAVAILABLE')(error) && secretFree(error)
  );
  client.failures.HeadObjectCommand = s3Error(503, 'SlowDown');
  await assert.rejects(
    provider.delete({ ...base, objectRef: 'adcp-rows/ns/e.jsonl', nativeVersionRef }, signal()),
    isCode('PROVIDER_UNAVAILABLE')
  );
  // An outage is never reported as "this version is gone": stat rejects instead of returning null.
  for (const status of [
    [500, 'InternalError'],
    [403, 'AccessDenied'],
    [503, 'SlowDown'],
  ]) {
    client.failures.HeadObjectCommand = s3Error(...status);
    await assert.rejects(
      provider.stat({ ...base, objectRef: 'adcp-rows/ns/e.jsonl', nativeVersionRef }, signal()),
      error => isCode('PROVIDER_UNAVAILABLE')(error) && secretFree(error)
    );
  }
  // A delete marker (405), a precondition failure and a malformed version are not this object.
  for (const status of [
    [405, 'MethodNotAllowed'],
    [412, 'PreconditionFailed'],
    [400, 'BadRequest'],
    [404, 'NotFound'],
  ]) {
    client.failures.HeadObjectCommand = s3Error(...status);
    assert.equal(
      await provider.stat({ ...base, objectRef: 'adcp-rows/ns/e.jsonl', nativeVersionRef }, signal()),
      null,
      String(status[0])
    );
  }
  // Malformed metadata fails closed instead of reporting a size.
  const send = client.send.bind(client);
  for (const length of [undefined, -1, 1.5, '10']) {
    client.send = async (command, options) => ({ ...(await send(command, options)), ContentLength: length });
    await assert.rejects(
      provider.stat({ ...base, objectRef: 'adcp-rows/ns/e.jsonl', nativeVersionRef }, signal()),
      isCode('PROVIDER_UNAVAILABLE'),
      String(length)
    );
  }
  client.send = send;
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    provider.stat({ ...base, objectRef: 'adcp-rows/ns/e.jsonl', nativeVersionRef }, { signal: aborted.signal }),
    isCode('ABORTED')
  );
});

test('deadlines and cancellation propagate as abortSignal and stable codes', async t => {
  // AbortSignal.timeout uses an unreferenced timer; the hanging fake supplies
  // no active I/O to keep the event loop alive while that deadline expires.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const client = createFakeS3();
  client.hang = true;
  const provider = createS3ReportingRowObjectProviderV1({ client });
  await assert.rejects(
    provider.probe({ ...base, prefix: 'adcp-rows' }, { signal: AbortSignal.timeout(20) }),
    isCode('DEADLINE_EXCEEDED')
  );
  const controller = new AbortController();
  const pending = provider.get(
    { ...base, objectRef: 'adcp-rows/ns/x', nativeVersionRef: 'abc', maxBytes: 10 },
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
      if (!versioned) {
        await assert.rejects(provider.probe({ location, prefix: 'adcp-rows' }, signal()), isCode('UNSAFE_BINDING'));
        continue;
      }
      const passed = await runReportingRowObjectProviderConformanceV1(provider, { location, prefix: 'adcp-rows' });
      assert.equal(passed.length, 8);
      const created = await provider.putIfAbsent(
        {
          location,
          objectRef: 'adcp-rows/ns/emulator.jsonl',
          bytes: Buffer.from('{"a":1}\n'),
          contentType: 'application/x-ndjson',
          metadata: { 'adcp-installation': 'emulator' },
        },
        signal()
      );
      assert.doesNotMatch(created.nativeVersionRef, /^"/);
      const foreign = created.nativeVersionRef.replace(/.$/, c => (c === 'a' ? 'b' : 'a'));
      const pinned = { location, objectRef: 'adcp-rows/ns/emulator.jsonl' };
      assert.equal(await provider.get({ ...pinned, nativeVersionRef: foreign, maxBytes: 100 }, signal()), null);
      assert.equal(await provider.delete({ ...pinned, nativeVersionRef: foreign }, signal()), 'absent');
      assert.equal(
        await provider.delete(
          { location, objectRef: 'adcp-rows/ns/emulator.jsonl', nativeVersionRef: created.nativeVersionRef },
          signal()
        ),
        'deleted'
      );
    }
  });
});
