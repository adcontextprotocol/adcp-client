'use strict';
// Every reader of a schema root in one loader epoch shares one read and one
// parse of each document: core registration, the tool and canonical
// validators, schema-ref validators, the compile-outcome content digest, and
// the document getters. Shared documents are frozen, so one caller's mutation
// cannot reach another, and a new epoch reads the files again. Reads and
// parses are counted through the fs module and JSON.parse the SDK calls; no
// SDK internals are replaced.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const loader = require('../../dist/lib/validation/schema-loader');
const { ADCP_VERSION } = require('../../dist/lib/version');

/**
 * Run `fn` and count, per `.json` file under `root`, fs.readFileSync calls, and
 * JSON.parse calls on text one of those reads returned. Byte-identical files
 * share a text, so parses are counted per text against the files that have it.
 */
function countRootWork(root, fn) {
  const reads = new Map();
  const textFiles = new Map();
  const textParses = new Map();
  const prefix = path.resolve(root) + path.sep;
  const originalRead = fs.readFileSync;
  const originalParse = JSON.parse;
  fs.readFileSync = function countingReadFileSync(file, ...rest) {
    const result = originalRead.call(this, file, ...rest);
    if (typeof file === 'string') {
      const resolved = path.resolve(file);
      if (resolved.startsWith(prefix) && resolved.endsWith('.json')) {
        const rel = path.relative(root, resolved).split(path.sep).join('/');
        reads.set(rel, (reads.get(rel) ?? 0) + 1);
        const text = typeof result === 'string' ? result : result.toString('utf8');
        if (!textFiles.has(text)) textFiles.set(text, new Set());
        textFiles.get(text).add(rel);
      }
    }
    return result;
  };
  JSON.parse = function countingParse(text, ...rest) {
    if (typeof text === 'string' && textFiles.has(text)) textParses.set(text, (textParses.get(text) ?? 0) + 1);
    return originalParse.call(this, text, ...rest);
  };
  try {
    fn();
  } finally {
    fs.readFileSync = originalRead;
    JSON.parse = originalParse;
  }
  const extraParses = {};
  for (const [text, n] of textParses) {
    const files = [...textFiles.get(text)].sort();
    if (n > files.length) extraParses[files.join(' = ')] = n;
  }
  return { reads, extraParses };
}

function repeated(counts) {
  return Object.fromEntries([...counts].filter(([, n]) => n > 1).sort());
}

function withValidatorCacheDir(dir, fn) {
  const previous = process.env.ADCP_VALIDATOR_CACHE_DIR;
  process.env.ADCP_VALIDATOR_CACHE_DIR = dir;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.ADCP_VALIDATOR_CACHE_DIR;
    else process.env.ADCP_VALIDATOR_CACHE_DIR = previous;
  }
}

test('every reader of the packaged root reads and parses each document at most once', t => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-parse-once-cache-'));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  loader._resetValidationLoader();
  t.after(() => loader._resetValidationLoader());
  const root = loader.resolveSchemaRoot(ADCP_VERSION);

  const { reads, extraParses } = countRootWork(root, () =>
    withValidatorCacheDir(cacheDir, () => {
      // Content digest of the root (compile-outcome cache), before any compile.
      assert.equal(loader.definesToolRequest('get_products', ADCP_VERSION), true);
      // Core registration plus a modular tool validator.
      assert.ok(loader.getValidator('get_products', 'request', ADCP_VERSION));
      assert.ok(loader.getValidator('create_media_buy', 'sync', ADCP_VERSION));
      // Canonical validators register the modular graph in their own Ajv.
      assert.ok(loader.getCanonicalToolValidatorForVersion('get_products', 'request', ADCP_VERSION));
      // Each schema-ref validator registers the modular graph in its own Ajv.
      assert.ok(loader.getSchemaValidatorByRef('core/mcp-webhook-payload.json', ADCP_VERSION));
      assert.ok(loader.getSchemaValidatorByRef('account/sync-accounts-response.json', ADCP_VERSION));
      // A release-precision pin of a prerelease is its own bundle key on the same root.
      const alias = loader.toReleasePrecisionWire(ADCP_VERSION);
      assert.equal(loader.resolveSchemaRoot(alias), root);
      assert.ok(loader.getSchemaValidatorByRef('core/pagination-request.json', alias));
      assert.ok(loader.getToolSchemaDocument('get_products', 'request', alias));
      // Document getters, repeated as server dispatch and projection repeat them.
      for (let i = 0; i < 3; i++) {
        assert.ok(loader.getToolSchemaDocument('get_products', 'request', ADCP_VERSION));
        assert.ok(loader.getToolSchemaDocument('create_media_buy', 'sync', ADCP_VERSION));
        assert.ok(loader.getSchemaDocumentByRef('core/ext.json', ADCP_VERSION));
        loader.schemaAllowsTopLevelField('get_products', 'brand', ADCP_VERSION);
        loader.getRequestSchemaEntityPaths('create_media_buy', ADCP_VERSION);
      }
    })
  );

  // The passes above really walked the root, so the bound below is not vacuous.
  assert.ok(reads.size > 500, `expected the root walks to read the root, read ${reads.size} documents`);
  assert.ok(reads.has('index.json'), 'getToolSchemaDocument reads index.json');
  assert.deepEqual(repeated(reads), {}, 'documents read more than once');
  assert.deepEqual(extraParses, {}, 'documents parsed more than once');
});

test('shared documents are frozen, so a caller cannot change what another caller reads', t => {
  loader._resetValidationLoader();
  t.after(() => loader._resetValidationLoader());

  const first = loader.getToolSchemaDocument('get_products', 'request', ADCP_VERSION).schema;
  const second = loader.getToolSchemaDocument('get_products', 'request', ADCP_VERSION).schema;
  assert.equal(second, first, 'callers share one parsed document');
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.properties), 'the shared document is deep-frozen');
  assert.throws(() => {
    first.properties.injected = { type: 'string' };
  }, TypeError);
  assert.throws(() => {
    delete first.properties.brief;
  }, TypeError);

  assert.equal(Object.hasOwn(second.properties, 'injected'), false, 'the other caller sees no change');
  assert.ok(Object.hasOwn(second.properties, 'brief'));

  const byRef = loader.getSchemaDocumentByRef('core/ext.json', ADCP_VERSION).schema;
  assert.ok(Object.isFrozen(byRef));
});

test('a document changed on disk is read again in a new epoch, and not within one', t => {
  const VERSION = '9.2.0';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-parse-once-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => loader._resetValidationLoader());
  const id = rel => `https://adcontextprotocol.org/schemas/${VERSION}/${rel}`;
  const write = (rel, value) => {
    const file = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  const ext = title => ({ $schema: 'http://json-schema.org/draft-07/schema#', $id: id('core/ext.json'), title });
  write('index.json', { adcp_version: VERSION });
  write('core/ext.json', ext('before'));
  write('media-buy/get-products-request.json', { $id: id('media-buy/get-products-request.json'), type: 'object' });

  const titleInEpoch = () => loader.getSchemaDocumentByRef('core/ext.json', VERSION).schema.title;

  // Counted inside the scope: entering a root checks its documents itself.
  loader.withExternalSchemaRoot(VERSION, root, () => {
    assert.equal(titleInEpoch(), 'before');
    write('core/ext.json', ext('after'));
    const { reads } = countRootWork(root, () => assert.equal(titleInEpoch(), 'before'));
    assert.equal(reads.get('core/ext.json'), undefined, 'the same epoch reuses its parse');
  });
  // Re-entering an unsettled root starts a new epoch, which reads the file again.
  loader.withExternalSchemaRoot(VERSION, root, () => {
    const { reads } = countRootWork(root, () => assert.equal(titleInEpoch(), 'after'));
    assert.equal(reads.get('core/ext.json'), 1);
  });
});
