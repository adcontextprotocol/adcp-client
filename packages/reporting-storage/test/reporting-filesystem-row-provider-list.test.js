/**
 * Filesystem row-object provider: `list`. The provider conformance suite covers the contract; these cover
 * walk order, resuming across deletes, and what the provider refuses to list.
 */
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { after, before, describe, test } = require('node:test');

const { createFilesystemReportingRowObjectProviderV1, isReportingRowStoreError } = require('./helpers/ledger.js');

describe('filesystem row-object provider list', () => {
  let root;
  let provider;
  const base = { location: { root: 'rows' } };
  const context = () => ({ signal: AbortSignal.timeout(5_000) });
  const write = (name, body = 'x') => {
    const target = path.join(root, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  };
  async function listAll(prefix, pageSize, { afterEach } = {}) {
    const found = [];
    let pageToken;
    for (let page = 0; page < 100; page += 1) {
      const result = await provider.list({ ...base, prefix, pageSize, ...(pageToken ? { pageToken } : {}) }, context());
      found.push(...result.objects);
      if (afterEach) await afterEach(result);
      pageToken = result.nextPageToken;
      if (pageToken === undefined) return found;
    }
    throw new Error('did not finish');
  }

  before(() => {
    root = mkdtempSync(path.join(tmpdir(), 'adcp-fs-list-'));
    provider = createFilesystemReportingRowObjectProviderV1({ roots: { rows: root } });
    for (const name of [
      'p/ns/a.jsonl',
      'p/ns/b/1.jsonl',
      'p/ns/b/2.jsonl.gz',
      'p/ns/b.jsonl', // the walk visits the directory b/ before the file b.jsonl
      'p/ns/c.jsonl',
      'p/ns/c.jsonl.0123.tmp', // a partial write, never an object
      'p/other/z.jsonl',
      'p-sibling/ns/y.jsonl',
    ]) {
      write(name);
    }
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  test('lists every object under the prefix once, in a stable order, whatever the page size', async () => {
    const expected = ['p/ns/a.jsonl', 'p/ns/b/1.jsonl', 'p/ns/b/2.jsonl.gz', 'p/ns/b.jsonl', 'p/ns/c.jsonl'];
    for (const pageSize of [1, 2, 3, 5, 50]) {
      const keys = (await listAll('p/ns/', pageSize)).map(entry => entry.objectRef);
      assert.deepEqual(keys, expected, `pageSize ${pageSize}`);
    }
  });

  test('reports the version, size and write time the other operations use, and is confined to the prefix', async () => {
    const [entry] = await listAll('p/ns/a', 10);
    assert.equal(entry.objectRef, 'p/ns/a.jsonl');
    assert.equal(entry.sizeBytes, 1);
    const stat = await provider.stat(
      { ...base, objectRef: entry.objectRef, nativeVersionRef: entry.nativeVersionRef },
      context()
    );
    assert.deepEqual(stat, { nativeVersionRef: entry.nativeVersionRef, sizeBytes: 1 });
    assert.ok(Math.abs(Date.parse(entry.createdAt) - Date.now()) < 60_000);
    assert.deepEqual(await listAll('p/nothing/', 10), []);
    assert.deepEqual(await listAll('nowhere/', 10), []);
    assert.deepEqual(
      (await listAll('p-sibling/', 10)).map(item => item.objectRef),
      ['p-sibling/ns/y.jsonl']
    );
  });

  test('resumes after the object a previous page ended on was deleted', async () => {
    write('q/ns/1.jsonl');
    write('q/ns/2.jsonl');
    write('q/ns/3.jsonl');
    const seen = [];
    await listAll('q/ns/', 1, {
      afterEach: async result => {
        for (const entry of result.objects) {
          seen.push(entry.objectRef);
          await provider.delete(
            { ...base, objectRef: entry.objectRef, nativeVersionRef: entry.nativeVersionRef },
            context()
          );
        }
      },
    });
    assert.deepEqual(seen, ['q/ns/1.jsonl', 'q/ns/2.jsonl', 'q/ns/3.jsonl']);
  });

  test('refuses a bad page size, an unknown root and a prefix that climbs out', async () => {
    const code = expected => error => isReportingRowStoreError(error) && error.code === expected;
    await assert.rejects(() => provider.list({ ...base, prefix: 'p/', pageSize: 0 }, context()), code('INVALID_INPUT'));
    await assert.rejects(
      () => provider.list({ ...base, prefix: 'p/', pageSize: 1.5 }, context()),
      code('INVALID_INPUT')
    );
    await assert.rejects(
      () => provider.list({ location: { root: 'missing' }, prefix: 'p/', pageSize: 1 }, context()),
      code('UNSAFE_BINDING')
    );
    await assert.rejects(
      () => provider.list({ ...base, prefix: '../', pageSize: 1 }, context()),
      code('INVALID_INPUT')
    );
    await assert.rejects(
      () => provider.list({ ...base, prefix: 'p/../../x', pageSize: 1 }, context()),
      code('INVALID_INPUT')
    );
  });
});
