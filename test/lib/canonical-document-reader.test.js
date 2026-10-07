const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { createCanonicalReferenceResolver, CanonicalDocumentReadError } = require('../../dist/lib/canonical-references');
const uri = 'https://storage.googleapis.com/owned-fixture/contracts/row-schema.json';
const load = () => readFile('test/fixtures/reporting-interop/resources/row-schema.json');
const digest = body => `sha256:${createHash('sha256').update(body).digest('hex')}`;

test('private document transport reauthorizes despite a warm cache and preserves digest validation', async () => {
  const body = await load();
  let allowed = true,
    reads = 0;
  const resolver = createCanonicalReferenceResolver({
    cache: {
      get() {
        throw new Error('private cache lookup');
      },
      set() {
        throw new Error('private cache write');
      },
    },
    documentReader: {
      async read(request) {
        assert.equal(request.uri, uri);
        assert.ok(request.signal instanceof AbortSignal);
        reads++;
        if (!allowed) throw new CanonicalDocumentReadError('access_denied');
        return { body: await load(), contentType: 'application/schema+json' };
      },
    },
  });
  const ref = { uri, digest: digest(body) };
  assert.equal((await resolver.resolve(ref)).ok, true);
  assert.equal((await resolver.resolve(ref)).fromCache, false);
  allowed = false;
  const denied = await resolver.resolve(ref);
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'access_denied');
  allowed = true;
  assert.equal((await resolver.resolve({ ...ref, digest: digest('corrupted') })).error.code, 'digest_mismatch');
  assert.equal(reads, 4);
});

test('private transport byte caps and total deadline sanitize errors', async () => {
  const body = await load(),
    ref = { uri, digest: digest(body) };
  const cap = createCanonicalReferenceResolver({
    maxBodyBytes: 1,
    documentReader: {
      async read() {
        return { body: await load() };
      },
    },
  });
  assert.equal((await cap.resolve(ref)).error.code, 'body_too_large');
  let cancelled;
  const stalled = createCanonicalReferenceResolver({
    timeoutMs: 10,
    documentReader: {
      read({ signal }) {
        cancelled = signal;
        return new Promise(() => {});
      },
    },
  });
  assert.equal((await stalled.resolve(ref)).error.code, 'network_error');
  assert.equal(cancelled.aborted, true);
  const broken = createCanonicalReferenceResolver({
    documentReader: {
      async read() {
        throw new Error('SECRET_SENTINEL');
      },
    },
  });
  assert.ok(!JSON.stringify(await broken.resolve(ref)).includes('SECRET_SENTINEL'));
});

test('private transport keeps strict duplicate-key JSON parsing', async () => {
  const body = Buffer.from('{"key":1,"key":2}');
  const resolver = createCanonicalReferenceResolver({
    documentReader: {
      async read() {
        return { body };
      },
    },
  });
  const result = await resolver.resolve({ uri, digest: digest(body) });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'invalid_document');
});

test('private document options fail at construction and caller cancellation never starts transport', async () => {
  const documentReader = {
    async read() {
      throw new Error('unexpected I/O');
    },
  };
  assert.throws(() => createCanonicalReferenceResolver({ documentReader, timeoutMs: 60001 }), RangeError);
  const signal = AbortSignal.abort();
  const body = await load();
  const resolver = createCanonicalReferenceResolver({ documentReader, signal });
  const result = await resolver.resolve({ uri, digest: digest(body) });
  assert.equal(result.error.code, 'aborted');
  assert.equal(result.error.retryable, false);
});

test('default private transport cannot be cleared per call and pinned external refs reauthorize without cache', async () => {
  const parentUri = 'https://storage.googleapis.com/owned-fixture/contracts/parent.json';
  const childUri = 'https://storage.googleapis.com/owned-fixture/contracts/child.json';
  const parent = await readFile('test/fixtures/canonical-private/parent.json');
  const child = await readFile('test/fixtures/canonical-private/child.json');
  let childAllowed = true,
    reads = 0;
  const resolver = createCanonicalReferenceResolver({
    cache: {
      get() {
        throw new Error('private cache lookup');
      },
      set() {
        throw new Error('private cache write');
      },
    },
    externalRefDigests: { [childUri]: digest(child) },
    documentReader: {
      async read(request) {
        reads++;
        if (request.uri === parentUri) return { body: await readFile('test/fixtures/canonical-private/parent.json') };
        assert.equal(request.uri, childUri);
        if (!childAllowed) throw new CanonicalDocumentReadError('access_denied');
        return { body: await readFile('test/fixtures/canonical-private/child.json') };
      },
    },
  });
  const ref = { uri: parentUri, digest: digest(parent) };
  assert.equal((await resolver.resolveFormatSchema(ref, { documentReader: undefined })).ok, true);
  assert.equal(reads, 2);
  childAllowed = false;
  assert.equal((await resolver.resolveFormatSchema(ref)).ok, false);
  assert.equal(reads, 4);
});
