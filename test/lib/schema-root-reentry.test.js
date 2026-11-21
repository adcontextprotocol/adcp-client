// Re-entering an unchanged external schema root keeps the loader state.
//
// Contract:
//   - withExternalSchemaRoot / registerExternalSchemaRoot of a root that was
//     already entered for the version in the current loader epoch, with every
//     document unchanged and settled (inode, size, mtime and ctime older than
//     3 s), keeps the compiled validators and the loader generation. Storyboard
//     runners enter the same root once per storyboard, so the validator set is
//     compiled once per process instead of once per storyboard.
//   - Anything else starts a fresh epoch, as every entry did before: a
//     rewritten or freshly written document, another root for the version, an
//     unregister. Validators then reflect the files on disk.
//   - With ADCP_VALIDATOR_CACHE_DIR set, a root check persists what it read,
//     so the first check of a settled root in a later process parses no
//     schema document. A persisted record applies only while its document's
//     stat key is unchanged.
//
// Observed through the public loader functions, Ajv.prototype.compile on the
// SDK's own `ajv`, fs.readFileSync calls on the root, and child processes for
// the cross-process cases. No SDK internals are replaced.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  registerExternalSchemaRoot,
  unregisterExternalSchemaRoot,
  withExternalSchemaRoot,
} = require('../../dist/lib/testing');
const { getValidator, getSchemaLoaderGeneration } = require('../../dist/lib/validation/schema-loader');

const SDK_ROOT = path.resolve(__dirname, '../..');
const CACHE_MODULE = path.join(SDK_ROOT, 'dist/lib/validation/validator-cache.js');
const VERSION = '9.1.0';
const SETTLE_MARGIN_MS = 3500;
const RESPONSE_REL = 'bundled/media-buy/get-products-response.json';

const tempDirs = [];
after(() => {
  unregisterExternalSchemaRoot(VERSION);
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- builders

function tempDir(label) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `adcp-reentry-${label}-`)));
  fs.chmodSync(dir, 0o700);
  tempDirs.push(dir);
  return dir;
}

function schemaId(rel, version = VERSION) {
  return `https://adcontextprotocol.org/schemas/${version}/${rel.replace(/^bundled\//, '')}`;
}

/** A bundled response schema that accepts `kind` values from `kinds`. */
function responseSchema(kinds, version = VERSION) {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: schemaId(RESPONSE_REL, version),
    type: 'object',
    required: ['kind'],
    properties: { kind: { enum: kinds } },
  };
}

function writeFile(root, rel, value) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

/** A raw root: index.json, one bundled response tool and a few modular documents. */
function writeRoot(label, { kinds = ['a'] } = {}) {
  const root = tempDir(label);
  writeFile(root, 'index.json', { adcp_version: VERSION });
  writeFile(root, RESPONSE_REL, responseSchema(kinds));
  for (const rel of ['core/ext.json', 'enums/channel.json']) {
    writeFile(root, rel, { $schema: 'http://json-schema.org/draft-07/schema#', $id: schemaId(rel), type: 'object' });
  }
  return root;
}

/** Rewrite a file with its own bytes: the content is unchanged, its mtime and ctime are new. */
function rewrite(root, rel) {
  const file = path.join(root, ...rel.split('/'));
  fs.writeFileSync(file, fs.readFileSync(file));
}

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

// ---------------------------------------------------------------- observation

const ajvModule = require(require.resolve('ajv', { paths: [SDK_ROOT] }));
const Ajv = ajvModule.default || ajvModule;

/** Run `fn` and count Ajv.prototype.compile calls on the SDK's ajv. */
function countCompiles(fn) {
  const original = Ajv.prototype.compile;
  let compiles = 0;
  Ajv.prototype.compile = function countingCompile(...args) {
    compiles++;
    return original.apply(this, args);
  };
  try {
    return { result: fn(), compiles };
  } finally {
    Ajv.prototype.compile = original;
  }
}

function enterAndValidate(root) {
  return withExternalSchemaRoot(VERSION, root, () => {
    const validate = getValidator('get_products', 'sync', VERSION);
    return { validate, generation: getSchemaLoaderGeneration(), acceptsB: validate({ kind: 'b' }) };
  });
}

const CHILD = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { root, version, steps } = JSON.parse(process.env.PLAN);
const prefix = root + path.sep;
let documentReads = 0;
const original = fs.readFileSync;
fs.readFileSync = function countingReadFileSync(file, ...rest) {
  if (typeof file === 'string') {
    const resolved = path.resolve(file);
    if (resolved.startsWith(prefix) && resolved.endsWith('.json') && resolved !== path.join(root, 'index.json')) {
      documentReads++;
    }
  }
  return original.call(this, file, ...rest);
};
const testing = require(path.join(process.env.SDK_ROOT, 'dist/lib/testing'));
const out = [];
for (const step of steps) {
  const before = documentReads;
  let outcome;
  try {
    if (step === 'register') testing.registerExternalSchemaRoot(version, root);
    else testing.withExternalSchemaRoot(version, root, () => {});
    outcome = 'ok';
  } catch (error) {
    outcome = String(error.message);
  }
  out.push({ step, outcome, documentReads: documentReads - before });
}
const cacheModuleLoaded = Object.prototype.hasOwnProperty.call(require.cache, process.env.CACHE_MODULE);
process.stdout.write('@@RESULT@@' + JSON.stringify({ out, cacheModuleLoaded }) + '\n');
`;

function runChild(root, steps, cacheDir) {
  const env = { ...process.env, SDK_ROOT, CACHE_MODULE, PLAN: JSON.stringify({ root, version: VERSION, steps }) };
  delete env.ADCP_VALIDATOR_CACHE_DIR;
  if (cacheDir !== undefined) env.ADCP_VALIDATOR_CACHE_DIR = cacheDir;
  const result = spawnSync(process.execPath, ['-e', CHILD], { env, encoding: 'utf8', timeout: 120_000 });
  const line = result.stdout.split('\n').find(l => l.startsWith('@@RESULT@@'));
  assert.ok(result.status === 0 && line, `child failed (${result.status}): ${result.stderr}`);
  return JSON.parse(line.slice('@@RESULT@@'.length));
}

// ---------------------------------------------------------------- fixtures

const settled = {};
before(async () => {
  for (const label of ['scoped', 'registered', 'rewritten', 'changed', 'other-a', 'other-b', 'persist', 'stale']) {
    settled[label] = writeRoot(label);
  }
  await waitUntilSettled(Object.values(settled));
});

// ---------------------------------------------------------------- in-process epochs

test('re-entering an unchanged settled root keeps its compiled validators and the loader generation', () => {
  const root = settled.scoped;
  const first = enterAndValidate(root);
  const again = countCompiles(() => enterAndValidate(root));
  assert.strictEqual(again.result.validate, first.validate, 'the same compiled validator');
  assert.equal(again.result.generation, first.generation, 'no new loader epoch');
  assert.equal(again.compiles, 0, 'no Ajv compile on re-entry');
});

test('re-registering an unchanged settled root keeps its validators; unregistering starts a fresh epoch', () => {
  const root = settled.registered;
  registerExternalSchemaRoot(VERSION, root);
  const first = getValidator('get_products', 'sync', VERSION);
  const generation = getSchemaLoaderGeneration();
  registerExternalSchemaRoot(VERSION, root);
  assert.strictEqual(getValidator('get_products', 'sync', VERSION), first);
  assert.equal(getSchemaLoaderGeneration(), generation);
  unregisterExternalSchemaRoot(VERSION);
  registerExternalSchemaRoot(VERSION, root);
  assert.notStrictEqual(getValidator('get_products', 'sync', VERSION), first, 'unregister ended the epoch');
  assert.ok(getSchemaLoaderGeneration() > generation);
  unregisterExternalSchemaRoot(VERSION);
});

test('a document rewritten with the same bytes starts a fresh epoch on the next entry', () => {
  const root = settled.rewritten;
  const first = enterAndValidate(root);
  rewrite(root, 'core/ext.json');
  const again = countCompiles(() => enterAndValidate(root));
  assert.notStrictEqual(again.result.validate, first.validate);
  assert.ok(again.result.generation > first.generation);
  assert.equal(again.compiles, 1, 'the validator is compiled again');
});

test('a changed tool schema is what the next entry validates against', () => {
  const root = settled.changed;
  assert.equal(enterAndValidate(root).acceptsB, false);
  writeFile(root, RESPONSE_REL, responseSchema(['a', 'b']));
  assert.equal(enterAndValidate(root).acceptsB, true);
});

test('a freshly written root starts a fresh epoch on every entry, as before', () => {
  const root = writeRoot('fresh');
  const first = enterAndValidate(root);
  const again = enterAndValidate(root);
  assert.notStrictEqual(again.validate, first.validate);
  assert.ok(again.generation > first.generation);
});

test('entering another root for the version starts a fresh epoch, and so does returning to the first', () => {
  const a = settled['other-a'];
  const b = settled['other-b'];
  const first = enterAndValidate(a);
  const other = enterAndValidate(b);
  assert.ok(other.generation > first.generation);
  const back = enterAndValidate(a);
  assert.notStrictEqual(back.validate, first.validate);
  assert.ok(back.generation > other.generation);
  // Within one root the epoch then holds again.
  assert.strictEqual(enterAndValidate(a).validate, back.validate);
});

// ---------------------------------------------------------------- persisted identities

test('with ADCP_VALIDATOR_CACHE_DIR, a later process checks a settled root without parsing its documents', () => {
  const root = settled.persist;
  const cacheDir = path.join(tempDir('cache'), 'cache');
  const off = runChild(root, ['scope', 'register'], undefined);
  assert.equal(off.cacheModuleLoaded, false, 'the cache module stays unloaded with the variable unset');
  assert.ok(off.out[0].documentReads > 0, 'without the cache the first check parses the documents');

  const cold = runChild(root, ['scope', 'register'], cacheDir);
  const warm = runChild(root, ['scope', 'register'], cacheDir);
  assert.deepEqual(
    warm.out.map(s => s.outcome),
    off.out.map(s => s.outcome)
  );
  assert.deepEqual(
    cold.out.map(s => s.outcome),
    off.out.map(s => s.outcome)
  );
  assert.ok(cold.out[0].documentReads > 0, 'the first process parses and persists');
  assert.equal(warm.out[0].documentReads, 0, 'the next process parses no schema document');
  assert.equal(warm.out[1].documentReads, 0);
});

test('a persisted record is not used once its document changes: the changed version is rejected as before', () => {
  const root = settled.stale;
  const cacheDir = path.join(tempDir('cache-stale'), 'cache');
  assert.equal(runChild(root, ['register'], cacheDir).out[0].outcome, 'ok');
  // Same size, other release: only a re-read catches it.
  writeFile(root, RESPONSE_REL, responseSchema(['a'], '9.2.0'));
  const off = runChild(root, ['register'], undefined);
  const cached = runChild(root, ['register'], cacheDir);
  assert.match(off.out[0].outcome, /does not match/);
  assert.equal(cached.out[0].outcome, off.out[0].outcome);
  assert.ok(cached.out[0].documentReads > 0, 'the changed document is read');
});
