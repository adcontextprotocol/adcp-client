// External schema-root checks (registerExternalSchemaRoot / withExternalSchemaRoot)
// read each schema document once per check, and reuse what they learned about a
// file only while the file is unchanged and settled. Reads are counted through
// the fs module the SDK calls; no SDK internals are replaced.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { brotliCompressSync, brotliDecompressSync } = require('node:zlib');
const {
  registerExternalSchemaRoot,
  unregisterExternalSchemaRoot,
  withExternalSchemaRoot,
} = require('../../dist/lib/testing');
const {
  getActiveSchemaArtifactLocation,
  isExternalSchemaRootActive,
  resolveBundleKey,
} = require('../../dist/lib/validation/schema-loader');
const { loadBundledSchemaFile } = require('../../dist/lib/validation/bundled-schema-store');
const { ADCP_VERSION } = require('../../dist/lib/version');

const VERSION = '9.1.0';
const BUNDLE_KEY = '9.1';
const REPORTING_DIMENSION_PATTERN = '^[a-z][a-z0-9_]*$';
// The change caches a file's identity only when its mtime and ctime are older
// than 3 s; wait past that with headroom.
const SETTLE_MARGIN_MS = 3500;

const tempDirs = [];

// ---------------------------------------------------------------- builders

function tempRoot(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `adcp-root-reads-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function schemaId(version, rel) {
  return `https://adcontextprotocol.org/schemas/${version}/${rel}`;
}

/** A small raw AdCP schema document for `rel`, carrying a versioned `$id`. */
function schemaDocument(rel, version = VERSION) {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: schemaId(version, rel),
    title: path.basename(rel, '.json'),
    type: 'object',
    properties: { note: { type: 'string' } },
  };
}

/** Relative paths of the default raw root: several documents in a few domains. */
const RAW_DOCUMENTS = [
  'core/ext.json',
  'core/brand-ref.json',
  'enums/channel.json',
  'media-buy/get-products-request.json',
  'media-buy/get-products-response.json',
];

/**
 * Write a raw (modular, no bundled store) schema root: index.json plus one
 * document per entry. `extra` maps relative paths to literal file contents for
 * edge-case documents (null JSON, unparseable text).
 */
function writeRawRoot(root, { documents = RAW_DOCUMENTS, extra = {} } = {}) {
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ adcp_version: VERSION }));
  for (const rel of documents) writeFile(root, rel, JSON.stringify(schemaDocument(rel)));
  for (const [rel, content] of Object.entries(extra)) writeFile(root, rel, content);
  return root;
}

function writeFile(root, rel, content) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** An archive entry whose inlined reporting-dimension enum the stock root check opens to a pattern. */
function reportingDimensionEntry(rel) {
  return {
    $id: schemaId(VERSION, rel),
    type: 'object',
    properties: {
      dims: { type: 'array', items: { title: 'Reporting Dimension', type: 'string', enum: ['geo', 'device'] } },
    },
  };
}

/**
 * Archive-only root (bundled.schemas.br, no raw bundled files). `layout`:
 * 'no-bundled-dir' mirrors the npm package (bundled/ excluded) and needs a raw
 * modular document carrying the version; 'empty-bundled-dir' keeps an empty
 * bundled/ directory, which the version walk descends into.
 */
function writeArchiveRoot(root, layout) {
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ adcp_version: VERSION }));
  const entries = {
    'media-buy/a-request.json': reportingDimensionEntry('media-buy/a-request.json'),
    'media-buy/b-request.json': reportingDimensionEntry('media-buy/b-request.json'),
  };
  fs.writeFileSync(path.join(root, 'bundled.schemas.br'), brotliCompressSync(Buffer.from(JSON.stringify(entries))));
  if (layout === 'empty-bundled-dir') fs.mkdirSync(path.join(root, 'bundled'));
  else writeFile(root, 'core/ext.json', JSON.stringify(schemaDocument('core/ext.json')));
  return root;
}

/** Copy of the SDK's packaged schema root as npm ships it: package.json "files" drops bundled/**. */
function packagedArchiveRoot() {
  const key = resolveBundleKey(ADCP_VERSION);
  const source = path.join(__dirname, '../../dist/lib/schemas-data', key);
  const sourceBundled = path.join(source, 'bundled');
  const root = path.join(tempRoot('packaged'), key);
  fs.cpSync(source, root, {
    recursive: true,
    filter: entry => entry !== sourceBundled && !entry.startsWith(sourceBundled + path.sep),
  });
  return root;
}

function bundledEntryPath(root, rel) {
  return path.join(root, 'bundled', ...rel.split('/'));
}

// ---------------------------------------------------------------- observation

/**
 * Run `fn` and count fs.readFileSync calls on `.json` files under `root`.
 * Returns { result, reads } with reads: Map<relativePath, count>.
 */
function countRootReads(root, fn) {
  const reads = new Map();
  const original = fs.readFileSync;
  const prefix = path.resolve(root) + path.sep;
  fs.readFileSync = function countingReadFileSync(file, ...rest) {
    if (typeof file === 'string') {
      const resolved = path.resolve(file);
      if (resolved.startsWith(prefix) && resolved.endsWith('.json')) {
        const rel = path.relative(root, resolved).split(path.sep).join('/');
        reads.set(rel, (reads.get(rel) ?? 0) + 1);
      }
    }
    return original.call(this, file, ...rest);
  };
  try {
    return { result: fn(), reads };
  } finally {
    fs.readFileSync = original;
  }
}

/** Reads of schema documents, i.e. everything except the root's index.json. */
function documentReads(reads) {
  return new Map([...reads].filter(([rel]) => rel !== 'index.json'));
}

function total(reads) {
  return [...reads.values()].reduce((sum, n) => sum + n, 0);
}

function describeReads(reads) {
  return JSON.stringify(Object.fromEntries([...reads].sort()));
}

/** Wait until every file under `root` has mtime and ctime older than the settle margin. */
async function waitUntilSettled(roots) {
  let newest = 0;
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      const stat = fs.statSync(full);
      newest = Math.max(newest, stat.mtimeMs, stat.ctimeMs);
    }
  };
  for (const root of roots) visit(root);
  const remaining = newest + SETTLE_MARGIN_MS - Date.now();
  if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
}

function registered(root, fn) {
  registerExternalSchemaRoot(VERSION, root);
  try {
    return fn();
  } finally {
    unregisterExternalSchemaRoot(VERSION);
  }
}

// Roots whose files are allowed to settle before their tests run. Built once,
// so the file pays the settle wait once.
const settled = {};

before(async () => {
  settled.raw = writeRawRoot(tempRoot('settled-raw'));
  settled.sameSize = writeRawRoot(tempRoot('settled-same-size'));
  settled.nullDoc = writeRawRoot(tempRoot('settled-null'), { extra: { 'core/null-doc.json': 'null' } });
  settled.unparseable = writeRawRoot(tempRoot('settled-unparseable'), {
    extra: { 'core/broken.json': '{"$id": "https://adcontextprotocol.org/schemas/9.1.0/core/bro' },
  });
  settled.archiveNoBundledDir = writeArchiveRoot(tempRoot('settled-archive'), 'no-bundled-dir');
  await waitUntilSettled(Object.values(settled));
});

after(() => {
  unregisterExternalSchemaRoot(VERSION);
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- behavior + read counts

test('registering a raw root resolves every alias of the version to it, scoped and process-wide', () => {
  const root = writeRawRoot(tempRoot('behavior'));
  registered(root, () => {
    for (const alias of [VERSION, BUNDLE_KEY]) {
      assert.equal(isExternalSchemaRootActive(alias), true, alias);
      assert.deepEqual(getActiveSchemaArtifactLocation(alias), { bundle_key: BUNDLE_KEY, root, external: true });
    }
  });
  assert.equal(isExternalSchemaRootActive(BUNDLE_KEY), false, 'unregister removes the alias');
  const scoped = withExternalSchemaRoot(VERSION, root, () => getActiveSchemaArtifactLocation(BUNDLE_KEY));
  assert.deepEqual(scoped, { bundle_key: BUNDLE_KEY, root, external: true });
  assert.equal(isExternalSchemaRootActive(BUNDLE_KEY), false, 'the scope does not leak');
});

test('one registration of a freshly written root parses each schema document once, plus the shape probe', () => {
  const root = writeRawRoot(tempRoot('fresh'));
  const { reads } = countRootReads(root, () => registered(root, () => undefined));
  const docs = documentReads(reads);
  for (const rel of RAW_DOCUMENTS) assert.ok((docs.get(rel) ?? 0) >= 1, `${rel} is read by the version check`);
  // Fresh files are never cached: the version walk reads each document once and
  // the shape check's some() probe reads one document before it. Stock walks the
  // root twice (2 * documents + 1).
  assert.ok(
    total(docs) <= RAW_DOCUMENTS.length + 1,
    `expected at most ${RAW_DOCUMENTS.length + 1} document reads, got ${total(docs)}: ${describeReads(docs)}`
  );
});

test('after the files settle, a root check reads each document at most once, and repeat checks read none', () => {
  const root = settled.raw;

  const first = countRootReads(root, () => registered(root, () => isExternalSchemaRootActive(BUNDLE_KEY)));
  assert.equal(first.result, true);
  const firstDocs = documentReads(first.reads);
  for (const [rel, count] of firstDocs)
    assert.ok(count <= 1, `${rel} read ${count} times: ${describeReads(firstDocs)}`);
  assert.ok(total(firstDocs) <= RAW_DOCUMENTS.length, describeReads(firstDocs));

  const again = countRootReads(root, () => registered(root, () => getActiveSchemaArtifactLocation(VERSION)));
  assert.deepEqual(again.result, { bundle_key: BUNDLE_KEY, root, external: true });
  assert.equal(total(documentReads(again.reads)), 0, `re-registration read ${describeReads(again.reads)}`);
  assert.ok((again.reads.get('index.json') ?? 0) <= 1, describeReads(again.reads));

  const scoped = countRootReads(root, () =>
    withExternalSchemaRoot(VERSION, root, () => getActiveSchemaArtifactLocation(BUNDLE_KEY))
  );
  assert.deepEqual(scoped.result, { bundle_key: BUNDLE_KEY, root, external: true });
  assert.equal(total(documentReads(scoped.reads)), 0, `withExternalSchemaRoot read ${describeReads(scoped.reads)}`);
  assert.ok((scoped.reads.get('index.json') ?? 0) <= 1, describeReads(scoped.reads));
});

test('a rewrite of a settled document is re-read: same-size and different-size version changes are rejected', () => {
  const root = settled.sameSize;
  const sameSizeRel = 'media-buy/get-products-request.json';
  const otherRel = 'core/brand-ref.json';
  const sameSizeFile = path.join(root, ...sameSizeRel.split('/'));
  const otherFile = path.join(root, ...otherRel.split('/'));
  const original = fs.readFileSync(sameSizeFile, 'utf8');
  // Stock's message lists one group per document with an $id, sorted: the four
  // unchanged documents, then the rewritten one. A stale cached identity would
  // show up here as a missing or extra group.
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const foundIds = rewritten =>
    escape([...Array(RAW_DOCUMENTS.length - 1).fill('9.1.0 (9.1, 9.1.0)'), rewritten].join(', ') + '.');

  // Prime: every document is settled and has been read once.
  registered(root, () => undefined);

  const sameSize = original.replace('/schemas/9.1.0/', '/schemas/9.2.0/');
  assert.notEqual(sameSize, original);
  assert.equal(Buffer.byteLength(sameSize), Buffer.byteLength(original), 'the rewrite keeps the byte length');
  fs.writeFileSync(sameSizeFile, sameSize);
  const rejected = countRootReads(root, () =>
    assert.throws(() => registerExternalSchemaRoot(VERSION, root), {
      message: new RegExp(`does not match the requested version[\\s\\S]*; found ${foundIds('9.2.0 (9.2, 9.2.0)')}$`),
    })
  );
  assert.ok((rejected.reads.get(sameSizeRel) ?? 0) >= 1, `rewritten file re-read: ${describeReads(rejected.reads)}`);
  assert.throws(() => withExternalSchemaRoot(VERSION, root, () => undefined), /does not match the requested version/);
  assert.equal(isExternalSchemaRootActive(BUNDLE_KEY), false, 'a rejected root is not registered');

  fs.writeFileSync(sameSizeFile, original);
  registered(root, () => assert.equal(isExternalSchemaRootActive(BUNDLE_KEY), true, 'restored root registers'));

  const differentSize = fs.readFileSync(otherFile, 'utf8').replace('/schemas/9.1.0/', '/schemas/9.10.0/');
  fs.writeFileSync(otherFile, differentSize);
  assert.throws(() => registerExternalSchemaRoot(VERSION, root), {
    message: new RegExp(`does not match the requested version[\\s\\S]*; found ${foundIds('9.10.0 (9.10, 9.10.0)')}$`),
  });
  assert.throws(() => withExternalSchemaRoot(VERSION, root, () => undefined), /does not match the requested version/);
});

test('a document whose JSON is null makes registration throw the TypeError stock throws, fresh and settled', () => {
  const nullTypeError = { name: 'TypeError', message: "Cannot read properties of null (reading '$id')" };
  const fresh = writeRawRoot(tempRoot('fresh-null'), { extra: { 'core/null-doc.json': 'null' } });
  assert.throws(() => registerExternalSchemaRoot(VERSION, fresh), nullTypeError);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.throws(() => registerExternalSchemaRoot(VERSION, settled.nullDoc), nullTypeError, `attempt ${attempt}`);
    assert.throws(() => withExternalSchemaRoot(VERSION, settled.nullDoc, () => undefined), nullTypeError);
  }
  assert.equal(isExternalSchemaRootActive(BUNDLE_KEY), false);
});

test('an unparseable document is skipped, fresh and settled', () => {
  const fresh = writeRawRoot(tempRoot('fresh-unparseable'), { extra: { 'core/broken.json': '{"$id": ' } });
  registered(fresh, () => assert.equal(getActiveSchemaArtifactLocation(VERSION).root, fresh));
  for (let attempt = 0; attempt < 2; attempt++) {
    registered(settled.unparseable, () =>
      assert.equal(getActiveSchemaArtifactLocation(VERSION).root, settled.unparseable, `attempt ${attempt}`)
    );
    assert.equal(
      withExternalSchemaRoot(VERSION, settled.unparseable, () => getActiveSchemaArtifactLocation(BUNDLE_KEY).root),
      settled.unparseable
    );
  }
});

// ---------------------------------------------------------------- archive side effect (stock guard)
//
// The stock root check loads archive entries through the loader's JSON reader,
// which opens the reporting-dimension enum in place; for entries without
// compact definitions loadBundledSchemaFile returns that same cached object, so
// direct readers see the opened schema. That must stay exactly as stock.

test('archive-only root as npm ships it: the root check leaves archive entries as loadBundledSchemaFile read them', () => {
  const root = packagedArchiveRoot();
  assert.equal(fs.existsSync(path.join(root, 'bundled')), false);
  const archive = JSON.parse(brotliDecompressSync(fs.readFileSync(path.join(root, 'bundled.schemas.br'))).toString());
  const rels = Object.keys(archive);
  assert.ok(rels.length > 0);
  const read = () =>
    Object.fromEntries(rels.map(rel => [rel, structuredClone(loadBundledSchemaFile(bundledEntryPath(root, rel)))]));
  const beforeCheck = read();
  const insideScope = withExternalSchemaRoot(ADCP_VERSION, root, () => {
    assert.equal(getActiveSchemaArtifactLocation(ADCP_VERSION).root, root);
    return read();
  });
  assert.deepEqual(insideScope, beforeCheck);
  assert.deepEqual(read(), beforeCheck);
});

test('archive-only root without bundled/: the shape probe opens the first entry it reads, and only that one', () => {
  const opened = { title: 'Reporting Dimension', type: 'string', pattern: REPORTING_DIMENSION_PATTERN };
  const closed = { title: 'Reporting Dimension', type: 'string', enum: ['geo', 'device'] };
  const root = settled.archiveNoBundledDir;
  const items = rel => loadBundledSchemaFile(bundledEntryPath(root, rel)).properties.dims.items;
  for (let attempt = 0; attempt < 2; attempt++) {
    withExternalSchemaRoot(VERSION, root, () => {
      assert.deepEqual(items('media-buy/a-request.json'), opened, `scoped a, attempt ${attempt}`);
      assert.deepEqual(items('media-buy/b-request.json'), closed, `scoped b, attempt ${attempt}`);
    });
    assert.deepEqual(items('media-buy/a-request.json'), opened);
    registered(root, () => {
      assert.deepEqual(items('media-buy/a-request.json'), opened, `registered a, attempt ${attempt}`);
      assert.deepEqual(items('media-buy/b-request.json'), closed, `registered b, attempt ${attempt}`);
    });
  }
});

test('archive-only root with an empty bundled/: the version walk opens every archive entry', () => {
  const opened = { title: 'Reporting Dimension', type: 'string', pattern: REPORTING_DIMENSION_PATTERN };
  const root = writeArchiveRoot(tempRoot('archive-empty-bundled'), 'empty-bundled-dir');
  const items = rel => loadBundledSchemaFile(bundledEntryPath(root, rel)).properties.dims.items;
  withExternalSchemaRoot(VERSION, root, () => {
    assert.deepEqual(items('media-buy/a-request.json'), opened);
    assert.deepEqual(items('media-buy/b-request.json'), opened);
  });
  registered(root, () => {
    assert.deepEqual(items('media-buy/a-request.json'), opened);
    assert.deepEqual(items('media-buy/b-request.json'), opened);
  });
});
