/**
 * Azure Blob row-object provider against an in-memory fake of the official
 * `@azure/storage-blob` client surface it uses (BlobServiceClient.accountName,
 * getContainerClient, getBlockBlobClient, upload, getProperties, download,
 * delete, withVersion).
 *
 * Opt-in run (not in CI), e.g. with `npx azurite-blob --inMemoryPersistence`:
 * REPORTING_AZURE_TEST_CONNECTION_STRING=UseDevelopmentStorage=true node --test test/lib/reporting-azure-row-provider.test.js
 * Azurite does not implement blob versioning, so against it the test asserts the probe refuses the
 * account. Set REPORTING_AZURE_TEST_VERSIONED=1 with a connection string for a storage account that
 * has blob versioning enabled to run the full conformance suite.
 */
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { describe, test } = require('node:test');

const { createAzureBlobReportingRowObjectProviderV1 } = require('../../dist/lib/reporting/azure');
const {
  isReportingRowStoreError,
  runReportingRowObjectProviderConformanceV1,
} = require('../../dist/lib/reporting/ledger');

const SECRET = 'sig=SECRETSASSIGNATURE';

function restError(statusCode, code) {
  // Real RestErrors carry request URLs, which can include SAS tokens.
  return Object.assign(new Error(`${code}: https://rowsaccount.blob.core.windows.net/rows/key?${SECRET}`), {
    name: 'RestError',
    statusCode,
    code,
  });
}

function createFakeAzure({
  accountName = 'rowsaccount',
  containers = ['rows'],
  versioned = false,
  ignoreIfNoneMatch = false,
  publicAccess,
} = {}) {
  const blobs = new Map(); // key -> [{ versionId, etag, bytes, metadata, current }]
  const calls = [];
  const failures = {};
  let hang = false;
  let etagCounter = 0x8dc000000000000;
  let clock = Date.UTC(2026, 0, 1);
  const fail = async (op, options) => {
    calls.push({ op, options });
    if (hang) {
      await new Promise((_, reject) =>
        options?.abortSignal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))
        )
      );
    }
    if (failures[op]) {
      const error = failures[op];
      delete failures[op];
      throw error;
    }
  };
  const blobClient = (containerName, key, versionId) => {
    const versions = () => blobs.get(key) ?? [];
    const select = conditions => {
      if (!containers.includes(containerName)) throw restError(404, 'ContainerNotFound');
      if (versionId !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(versionId)) throw restError(400, 'InvalidQueryParameterValue');
        const version = versions().find(item => item.versionId === versionId);
        if (!version) throw restError(404, 'BlobNotFound');
        return version;
      }
      const current = versions().find(item => item.current);
      if (!current) throw restError(404, 'BlobNotFound');
      if (conditions?.ifMatch !== undefined && conditions.ifMatch !== current.etag) {
        throw restError(412, 'ConditionNotMet');
      }
      return current;
    };
    return {
      async upload(body, length, options = {}) {
        await fail('upload', options);
        assert.equal(versionId, undefined);
        if (!containers.includes(containerName)) throw restError(404, 'ContainerNotFound');
        const current = versions().find(item => item.current);
        if (options.conditions?.ifNoneMatch === '*' && current && !ignoreIfNoneMatch) {
          throw restError(409, 'BlobAlreadyExists');
        }
        const version = {
          versionId: versioned ? new Date((clock += 1000)).toISOString().replace('Z', '1234Z') : undefined,
          etag: `"0x${(etagCounter++).toString(16).toUpperCase()}"`,
          bytes: Buffer.from(body).subarray(0, length),
          metadata: options.metadata,
          headers: options.blobHTTPHeaders,
          current: true,
        };
        if (current) current.current = false;
        blobs.set(key, versioned ? [...versions(), version] : [version]);
        return { etag: version.etag, ...(versioned ? { versionId: version.versionId } : {}) };
      },
      async getProperties(options = {}) {
        await fail('getProperties', options);
        const version = select(options.conditions);
        const current = versions().find(item => item.current);
        return {
          etag: version.etag,
          versionId: versioned ? version.versionId : undefined,
          isCurrentVersion: version === current,
          contentLength: version.bytes.length,
        };
      },
      async download(offset = 0, count, options = {}) {
        await fail('download', { ...options, offset, count, versionId });
        const version = select(options.conditions);
        if (offset >= version.bytes.length && version.bytes.length > 0) throw restError(416, 'InvalidRange');
        const bytes = version.bytes.subarray(offset, count === undefined ? undefined : offset + count);
        const parts = [];
        for (let index = 0; index < bytes.length; index += 4) parts.push(bytes.subarray(index, index + 4));
        return {
          readableStreamBody: Readable.from(parts),
          contentLength: bytes.length,
          etag: version.etag,
          versionId: versioned ? version.versionId : undefined,
        };
      },
      async delete(options = {}) {
        await fail('delete', { ...options, versionId });
        const version = select(options.conditions);
        if (versionId !== undefined) {
          // Emulate the conservative service rule: the current version is removed via the base blob.
          if (version.current) throw restError(403, 'OperationNotAllowedOnRootBlob');
          blobs.set(
            key,
            versions().filter(item => item !== version)
          );
          return {};
        }
        if (versioned) version.current = false;
        else blobs.set(key, []);
        return {};
      },
      withVersion(next) {
        return blobClient(containerName, key, next);
      },
    };
  };
  return {
    accountName,
    calls,
    failures,
    blobs,
    set hang(value) {
      hang = value;
    },
    getContainerClient(containerName) {
      return {
        async getProperties(options = {}) {
          await fail('container.getProperties', options);
          if (!containers.includes(containerName)) throw restError(404, 'ContainerNotFound');
          return publicAccess ? { blobPublicAccess: publicAccess } : {};
        },
        getBlockBlobClient(key) {
          return blobClient(containerName, key, undefined);
        },
      };
    },
  };
}

const signal = () => ({ signal: AbortSignal.timeout(5_000) });
const base = { location: { account: 'rowsaccount', container: 'rows' } };
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
  assert.doesNotMatch(error.message, /sig=|SECRET|blob\.core/);
  return true;
};
const liveBlobs = client => [...client.blobs.values()].flat();

test('passes the shared provider conformance suite', async () => {
  const client = createFakeAzure({ versioned: true });
  const provider = createAzureBlobReportingRowObjectProviderV1({ client });
  const passed = await runReportingRowObjectProviderConformanceV1(provider, { ...base, prefix: 'adcp-rows' });
  assert.deepEqual(passed, [
    'probe',
    'create',
    'create-only',
    'ranged-read',
    'version-pinned-read',
    'exact-version-delete',
    'write-unique-version',
  ]);
  assert.equal(liveBlobs(client).length, 0, 'probe and conformance blobs and versions are removed');
  assert.ok(client.calls.every(call => call.options?.abortSignal instanceof AbortSignal));
});

test('create-only upload: If-None-Match, content headers, identifier-safe metadata', async () => {
  const client = createFakeAzure({ versioned: true });
  const provider = createAzureBlobReportingRowObjectProviderV1({ client });
  const created = await put(provider, 'adcp-rows/ns/a.jsonl.gz');
  assert.equal(created.created, true);
  assert.match(created.nativeVersion, /^\d{4}-\d{2}-\d{2}T/);
  const upload = client.calls.find(call => call.op === 'upload').options;
  assert.deepEqual(upload.conditions, { ifNoneMatch: '*' });
  assert.equal(upload.blobHTTPHeaders.blobContentType, 'application/gzip');
  assert.equal(upload.blobHTTPHeaders.blobContentEncoding, undefined);
  assert.deepEqual(upload.metadata, { adcp_installation: 'inst', adcp_intent: 'intent' });
});

test('upload and adopt refuse stores that return no versionId (versioning disabled)', async () => {
  const client = createFakeAzure();
  const provider = createAzureBlobReportingRowObjectProviderV1({ client });
  await assert.rejects(put(provider, 'adcp-rows/ns/a.jsonl'), error => {
    assert.ok(isCode('UNSAFE_BINDING')(error));
    assert.match(error.message, /versioning must be enabled/);
    return secretFree(error);
  });
  // The blob exists now, so the adopt path must refuse too rather than fall back to the ETag.
  await assert.rejects(put(provider, 'adcp-rows/ns/a.jsonl'), isCode('UNSAFE_BINDING'));
});

test('409 BlobAlreadyExists or 412 adopts the existing version', async () => {
  {
    const client = createFakeAzure({ versioned: true });
    const provider = createAzureBlobReportingRowObjectProviderV1({ client });
    const first = await put(provider, 'adcp-rows/ns/a.jsonl', 'first\n');
    assert.deepEqual(await put(provider, 'adcp-rows/ns/a.jsonl', 'second\n'), {
      created: false,
      nativeVersion: first.nativeVersion,
    });
    client.failures.upload = restError(412, 'ConditionNotMet');
    assert.deepEqual(await put(provider, 'adcp-rows/ns/a.jsonl', 'third\n'), {
      created: false,
      nativeVersion: first.nativeVersion,
    });
    const bytes = await provider.get(
      { ...base, key: 'adcp-rows/ns/a.jsonl', nativeVersion: first.nativeVersion, maxBytes: 100 },
      signal()
    );
    assert.equal(Buffer.from(bytes).toString(), 'first\n');
  }
});

test('reads pin versionId and honour ranges and the byte cap', async () => {
  {
    const client = createFakeAzure({ versioned: true });
    const provider = createAzureBlobReportingRowObjectProviderV1({ client });
    const key = 'adcp-rows/ns/r.jsonl';
    const { nativeVersion } = await put(provider, key, '0123456789abcdef');
    const ranged = await provider.get(
      { ...base, key, nativeVersion, range: { offset: 4, length: 6 }, maxBytes: 6 },
      signal()
    );
    assert.equal(Buffer.from(ranged).toString(), '456789');
    const call = client.calls.filter(item => item.op === 'download').at(-1).options;
    assert.equal(call.offset, 4);
    assert.equal(call.count, 6);
    assert.equal(call.versionId, nativeVersion);
    assert.equal(call.conditions, undefined, 'ETags never participate in version pinning');

    assert.equal(await provider.get({ ...base, key, nativeVersion: '"0x0"', maxBytes: 100 }, signal()), null);
    assert.equal(await provider.get({ ...base, key, nativeVersion: 'not-a-version', maxBytes: 100 }, signal()), null);
    assert.equal(
      await provider.get({ ...base, key, nativeVersion: '2020-01-01T00:00:00.0000000Z', maxBytes: 100 }, signal()),
      null
    );
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

test('a store that ignores versionid never serves or deletes a different version', async () => {
  const client = createFakeAzure({ versioned: true });
  const provider = createAzureBlobReportingRowObjectProviderV1({ client });
  const key = 'adcp-rows/ns/v.jsonl';
  const { nativeVersion } = await put(provider, key);
  // The fake drops the version pin, like a store without versioning, and answers from the base blob.
  const container = client.getContainerClient;
  client.getContainerClient = name => {
    const inner = container(name);
    return {
      ...inner,
      getBlockBlobClient(blobKey) {
        const blob = inner.getBlockBlobClient(blobKey);
        return { ...blob, withVersion: () => blob };
      },
    };
  };
  const foreign = '2020-01-01T00:00:00.0000000Z';
  assert.equal(await provider.get({ ...base, key, nativeVersion: foreign, maxBytes: 100 }, signal()), null);
  assert.equal(await provider.delete({ ...base, key, nativeVersion: foreign }, signal()), 'absent');
  assert.ok(await provider.get({ ...base, key, nativeVersion, maxBytes: 100 }, signal()));
});

test('streaming cap applies even when contentLength is absent', async () => {
  const client = createFakeAzure({ versioned: true });
  const provider = createAzureBlobReportingRowObjectProviderV1({ client });
  const { nativeVersion } = await put(provider, 'adcp-rows/ns/big.jsonl', 'x'.repeat(64));
  const container = client.getContainerClient;
  client.getContainerClient = name => {
    const inner = container(name);
    return {
      ...inner,
      getBlockBlobClient(key) {
        const blob = inner.getBlockBlobClient(key);
        return {
          ...blob,
          async download(...args) {
            const response = await blob.download(...args);
            delete response.contentLength;
            return response;
          },
        };
      },
    };
  };
  await assert.rejects(
    provider.get({ ...base, key: 'adcp-rows/ns/big.jsonl', nativeVersion, maxBytes: 10 }, signal()),
    isCode('ROWS_INTEGRITY_FAILED')
  );
});

test('delete removes only the exact version and is idempotent', async () => {
  {
    const client = createFakeAzure({ versioned: true });
    const provider = createAzureBlobReportingRowObjectProviderV1({ client });
    const key = 'adcp-rows/ns/d.jsonl';
    const { nativeVersion } = await put(provider, key);
    for (const foreign of ['"0x0"', 'not-a-version', '2020-01-01T00:00:00.0000000Z']) {
      assert.equal(await provider.delete({ ...base, key, nativeVersion: foreign }, signal()), 'absent');
    }
    assert.equal(liveBlobs(client).length, 1);
    assert.equal(await provider.delete({ ...base, key, nativeVersion }, signal()), 'deleted');
    assert.equal(liveBlobs(client).length, 0);
    assert.equal(await provider.delete({ ...base, key, nativeVersion }, signal()), 'absent');
  }
});

test('a delayed delete of an old version never removes an identical re-creation', async () => {
  const client = createFakeAzure({ versioned: true });
  const provider = createAzureBlobReportingRowObjectProviderV1({ client });
  const key = 'adcp-rows/ns/fence.jsonl';
  const first = await put(provider, key, 'same bytes\n');
  assert.equal(await provider.delete({ ...base, key, nativeVersion: first.nativeVersion }, signal()), 'deleted');
  const second = await put(provider, key, 'same bytes\n');
  assert.equal(second.created, true);
  assert.notEqual(second.nativeVersion, first.nativeVersion);
  assert.equal(await provider.delete({ ...base, key, nativeVersion: first.nativeVersion }, signal()), 'absent');
  const bytes = await provider.get({ ...base, key, nativeVersion: second.nativeVersion, maxBytes: 100 }, signal());
  assert.equal(Buffer.from(bytes).toString(), 'same bytes\n');
});

test('probe refuses missing, public, unversioned and non-create-only containers', async () => {
  const probe = (client, location = base.location) =>
    createAzureBlobReportingRowObjectProviderV1({ client }).probe({ location, prefix: 'adcp-rows' }, signal());
  const versioned = createFakeAzure({ versioned: true });
  await probe(versioned);
  assert.equal(liveBlobs(versioned).length, 0, 'probe blobs are cleaned up');
  const unversioned = createFakeAzure();
  await assert.rejects(probe(unversioned), error => {
    assert.ok(isCode('UNSAFE_BINDING')(error));
    assert.match(error.message, /blob versioning must be enabled/);
    return secretFree(error);
  });
  assert.equal(liveBlobs(unversioned).length, 0, 'probe blobs are cleaned up when refused');
  const ignoring = createFakeAzure({ ignoreIfNoneMatch: true, versioned: true });
  await assert.rejects(probe(ignoring), error => {
    assert.ok(isCode('UNSAFE_BINDING')(error));
    assert.match(error.message, /If-None-Match/);
    return secretFree(error);
  });
  assert.equal(liveBlobs(ignoring).length, 0, 'both probe versions are cleaned up');
  await assert.rejects(probe(createFakeAzure({ containers: [] })), isCode('UNSAFE_BINDING'));
  await assert.rejects(probe(createFakeAzure({ publicAccess: 'blob' })), isCode('UNSAFE_BINDING'));
  await assert.rejects(probe(createFakeAzure({ publicAccess: 'container' })), isCode('UNSAFE_BINDING'));
  const forbidden = createFakeAzure();
  forbidden.failures['container.getProperties'] = restError(403, 'AuthorizationPermissionMismatch');
  await assert.rejects(probe(forbidden), error => isCode('UNSAFE_BINDING')(error) && secretFree(error));
  await assert.rejects(
    probe(createFakeAzure(), { account: 'otheraccount', container: 'rows' }),
    isCode('UNSAFE_BINDING')
  );
});

test('credentialRef selects from a closed client map; locations never carry endpoints', async () => {
  const primary = createFakeAzure({ versioned: true });
  const tenant = createFakeAzure({ versioned: true });
  const provider = createAzureBlobReportingRowObjectProviderV1({ client: primary, clients: { tenant } });
  await put(provider, 'adcp-rows/ns/default.jsonl');
  await put(provider, 'adcp-rows/ns/tenant.jsonl', 'x', { credentialRef: 'tenant' });
  assert.equal(primary.calls.length, 1);
  assert.equal(tenant.calls.length, 1);
  await assert.rejects(put(provider, 'adcp-rows/ns/x.jsonl', 'x', { credentialRef: 'nope' }), error => {
    assert.ok(isCode('UNSAFE_BINDING')(error));
    assert.doesNotMatch(error.message, /nope/);
    return true;
  });
  for (const location of [
    {},
    { account: 'rowsaccount' },
    { account: 'Rows', container: 'rows' },
    { account: 'ab', container: 'rows' },
    { account: 'rowsaccount', container: 'Rows' },
    { account: 'rowsaccount', container: 'a--b' },
    { account: 'rowsaccount', container: 'rows', endpoint: 'https://evil.example' },
    { account: 'rowsaccount', container: 'rows', sas: SECRET },
  ]) {
    assert.throws(() => provider.validateLocation(location), isCode('INVALID_INPUT'));
  }
  assert.throws(() => createAzureBlobReportingRowObjectProviderV1({}), isCode('INVALID_INPUT'));
  assert.throws(
    () => createAzureBlobReportingRowObjectProviderV1({ client: { getContainerClient() {} } }),
    isCode('INVALID_INPUT')
  );
});

test('provider errors map to stable, secret-free codes', async () => {
  const client = createFakeAzure({ versioned: true });
  const provider = createAzureBlobReportingRowObjectProviderV1({ client });
  client.failures.upload = restError(500, 'InternalError');
  await assert.rejects(put(provider, 'adcp-rows/ns/e.jsonl'), error => {
    assert.ok(isCode('PROVIDER_UNAVAILABLE')(error));
    return secretFree(error);
  });
  const { nativeVersion } = await put(provider, 'adcp-rows/ns/e.jsonl');
  client.failures.download = restError(403, 'AuthorizationFailure');
  await assert.rejects(
    provider.get({ ...base, key: 'adcp-rows/ns/e.jsonl', nativeVersion, maxBytes: 100 }, signal()),
    error => isCode('PROVIDER_UNAVAILABLE')(error) && secretFree(error)
  );
  client.failures.delete = restError(503, 'ServerBusy');
  await assert.rejects(
    provider.delete({ ...base, key: 'adcp-rows/ns/e.jsonl', nativeVersion }, signal()),
    isCode('PROVIDER_UNAVAILABLE')
  );
});

test('deadlines and cancellation propagate as abortSignal and stable codes', async t => {
  // AbortSignal.timeout uses an unreferenced timer; the hanging fake supplies
  // no active I/O to keep the event loop alive while that deadline expires.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const client = createFakeAzure({ versioned: true });
  client.hang = true;
  const provider = createAzureBlobReportingRowObjectProviderV1({ client });
  await assert.rejects(
    provider.probe({ ...base, prefix: 'adcp-rows' }, { signal: AbortSignal.timeout(20) }),
    isCode('DEADLINE_EXCEEDED')
  );
  const controller = new AbortController();
  const pending = provider.get(
    { ...base, key: 'adcp-rows/ns/x', nativeVersion: '2026-01-01T00:00:00.0000000Z', maxBytes: 10 },
    { signal: controller.signal }
  );
  controller.abort();
  await assert.rejects(pending, isCode('ABORTED'));
  assert.ok(client.calls.every(call => call.options?.abortSignal instanceof AbortSignal));
});

const CONNECTION_STRING = process.env.REPORTING_AZURE_TEST_CONNECTION_STRING;
const VERSIONED = process.env.REPORTING_AZURE_TEST_VERSIONED === '1';
describe(
  'Azure Blob emulator',
  { skip: !CONNECTION_STRING && 'REPORTING_AZURE_TEST_CONNECTION_STRING not set' },
  () => {
    test(
      'probe refuses accounts without blob versioning (Azurite)',
      { skip: VERSIONED && 'versioned account' },
      async () => {
        const { BlobServiceClient } = require('@azure/storage-blob');
        const client = BlobServiceClient.fromConnectionString(CONNECTION_STRING);
        const container = `adcp-rows-nv-${process.pid}`;
        await client.getContainerClient(container).createIfNotExists();
        const provider = createAzureBlobReportingRowObjectProviderV1({ client });
        await assert.rejects(
          provider.probe({ location: { account: client.accountName, container }, prefix: 'adcp-rows' }, signal()),
          error => isCode('UNSAFE_BINDING')(error) && /blob versioning must be enabled/.test(error.message)
        );
        await client.getContainerClient(container).deleteIfExists();
      }
    );

    test(
      'conformance against a versioning-enabled account with the official client',
      { skip: !VERSIONED && 'REPORTING_AZURE_TEST_VERSIONED not set (Azurite has no blob versioning)' },
      async () => {
        const { BlobServiceClient } = require('@azure/storage-blob');
        const client = BlobServiceClient.fromConnectionString(CONNECTION_STRING);
        const container = `adcp-rows-${process.pid}`;
        await client.getContainerClient(container).createIfNotExists();
        const provider = createAzureBlobReportingRowObjectProviderV1({ client });
        const location = { account: client.accountName, container };
        const passed = await runReportingRowObjectProviderConformanceV1(provider, { location, prefix: 'adcp-rows' });
        assert.equal(passed.length, 7);
        const key = 'adcp-rows/ns/emulator.jsonl';
        const created = await provider.putIfAbsent(
          {
            location,
            key,
            bytes: Buffer.from('{"a":1}\n'),
            contentType: 'application/x-ndjson',
            metadata: { 'adcp-installation': 'emulator' },
          },
          signal()
        );
        assert.equal(await provider.get({ location, key, nativeVersion: '"0x0"', maxBytes: 100 }, signal()), null);
        assert.equal(await provider.delete({ location, key, nativeVersion: '"0x0"' }, signal()), 'absent');
        assert.equal(
          await provider.delete({ location, key, nativeVersion: created.nativeVersion }, signal()),
          'deleted'
        );
        await client.getContainerClient(container).deleteIfExists();
      }
    );
  }
);
