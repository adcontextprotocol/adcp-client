'use strict';
// With ADCP_VALIDATOR_CACHE_DIR set, the validator cache also keeps the
// modular tool validators (getValidator for schemas that $ref the release's
// shared documents) and the canonical tool validators
// (getCanonicalToolValidatorForVersion), keyed by the release's content, and
// serves their diagnostics without compiling them.
//
// Contract:
//   - A later process gets those validators without an Ajv compile, and a
//     failing payload's diagnostics compile nothing either.
//   - Every outcome a caller can see is identical cache off, cold and warm,
//     in any call order and with any mix of hits and misses: raw verdicts and
//     errors, validateRequest/validateResponse issues, registered ids, and
//     the validators' schema objects.
//   - Each validator served from the cache is its own function.
//   - A changed document is a miss; a damaged entry compiles live.
//
// Each run is a fresh child process. The child counts Ajv's top-level
// compiles (Ajv.prototype.compile and _compileSchemaEnv, the meta-schema
// excepted), lookups of validator entries and evaluations of cached modules.
// Nothing under test is replaced. There are no wall-clock assertions.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ADCP_VERSION } = require('../../dist/lib/version');

const SDK_ROOT = path.resolve(__dirname, '../..');
const VERSIONS = [...new Set(['3.0.25', '3.2.8', ADCP_VERSION])];
// Requests are modular in every release; 3.0.25 responses are modular too,
// later responses are mostly bundled (served by the bundled cache).
const TOOLS = [
  'activate_signal',
  'create_media_buy',
  'get_products',
  'sync_accounts',
  'sync_creatives',
  'update_media_buy',
];
// Schema refs validated through getSchemaValidatorByRef (the shared schema-ref registry) in every release.
const REFS = [
  'account/sync-accounts-request.json',
  'core/account-ref.json',
  'core/mcp-webhook-payload.json',
  'core/product.json',
];

const tempDirs = [];
const scenario = {};
after(async () => {
  // A filtered run never awaits the shared scenarios; let their children finish first.
  await Promise.allSettled(Object.values(scenario));
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function privateDir(label) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `adcp-vtool-${label}-`)));
  fs.chmodSync(dir, 0o700);
  tempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------- child process

const CHILD = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const cfg = JSON.parse(process.env.PLAN);
const cacheEntries = cfg.cacheDir ? path.join(cfg.cacheDir, 'v1') + path.sep : '\0';

const counts = { compile: 0, compileSchemaEnv: 0, addSchema: 0, lookups: 0, evaluated: 0, scans: 0, writes: 0 };
const readdirSync = fs.readdirSync;
fs.readdirSync = function countingReaddir(dir, ...rest) {
  if (typeof dir === 'string' && dir + path.sep === cacheEntries) counts.scans++;
  return readdirSync.call(this, dir, ...rest);
};
const writeFileSync = fs.writeFileSync;
fs.writeFileSync = function countingWrite(file, ...rest) {
  if (typeof file === 'string' && file.startsWith(cacheEntries)) counts.writes++;
  return writeFileSync.call(this, file, ...rest);
};
const openSync = fs.openSync;
fs.openSync = function countingOpen(file, ...rest) {
  if (typeof file === 'string' && file.startsWith(cacheEntries) && file.endsWith('.js')) counts.lookups++;
  return openSync.call(this, file, ...rest);
};
const Script = vm.Script;
vm.Script = class CountingScript extends Script {
  constructor(code, options) {
    super(code, options);
    if (options && typeof options.filename === 'string' && options.filename.startsWith(cacheEntries)) counts.evaluated++;
  }
};
const ajvModule = require(require.resolve('ajv', { paths: [cfg.sdkRoot] }));
const Ajv = ajvModule.default || ajvModule;
for (const [method, key] of [['compile', 'compile'], ['_compileSchemaEnv', 'compileSchemaEnv']]) {
  const original = Ajv.prototype[method];
  Ajv.prototype[method] = function countingAjvMethod(...args) {
    // The draft-07 meta-schema compiles once per Ajv instance for addSchema's check; not a tool validator.
    if (!(method === '_compileSchemaEnv' && args[0] && args[0].meta)) counts[key]++;
    return original.apply(this, args);
  };
}
// Document registrations; a new Ajv adds its meta-schemas through addSchema(_, _, true).
const addSchema = Ajv.prototype.addSchema;
Ajv.prototype.addSchema = function countingAddSchema(schema, key, meta, ...rest) {
  if (meta !== true) counts.addSchema += Array.isArray(schema) ? schema.length : 1;
  return addSchema.call(this, schema, key, meta, ...rest);
};

const loader = require(path.join(cfg.sdkRoot, 'dist/lib/validation/schema-loader.js'));
const validator = require(path.join(cfg.sdkRoot, 'dist/lib/validation/schema-validator.js'));
for (const [version, root] of cfg.externalRoots ?? []) loader.registerExternalSchemaRoot(version, root);

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Failing payloads that reach the documents a tool's schema refers to, plus a few whole-body ones. */
function payloadsFor(tool, direction, version) {
  const doc = loader.getToolSchemaDocument(tool, direction, version);
  const properties = Object.keys((doc && doc.schema.properties) || {}).sort().slice(0, 12);
  const out = [{}, [], null, Object.fromEntries(properties.map(p => [p, {}]))];
  for (const p of properties) for (const value of [7, {}, [{}]]) out.push({ [p]: value });
  return out.concat(cfg.extraPayloads ?? []);
}
// Errors as Ajv returns them, plus whether params that carry schema values are
// the (frozen) schema's own arrays, as a live compile's are.
const raw = (fn, payloads) => payloads.map(p => {
  const valid = fn(p);
  const errors = fn.errors && fn.errors.map(e => (e.params && Array.isArray(e.params.allowedValues)
    ? { ...e, allowedValuesFrozen: Object.isFrozen(e.params.allowedValues) } : e));
  return { valid, errors };
});

const steps = [];
const versions = cfg.reverse ? [...cfg.versions].reverse() : cfg.versions;
const tools = cfg.reverse ? [...cfg.tools].reverse() : cfg.tools;
const directions = cfg.reverse ? ['sync', 'request'] : ['request', 'sync'];
for (const version of versions) {
  for (const tool of tools) {
    for (const direction of directions) {
      const label = version + '|' + tool + '|' + direction;
      const modular = () => {
        steps.push({ label: label + '|get', run: () => {
          const fn = loader.getValidator(tool, direction, version);
          if (!fn) return { defined: false };
          (cfg.held ??= {})[label] = fn;
          return { defined: true, schema: digest(fn.schema), frozen: Object.isFrozen(fn.schema),
                   rootSchemaId: loader.getValidatorRootSchemaId(fn) ?? null, source: Object.hasOwn(fn, 'source') };
        } });
        steps.push({ label: label + '|raw', run: () => {
          const fn = loader.getValidator(tool, direction, version);
          return fn ? raw(fn, payloadsFor(tool, direction, version)) : null;
        } });
        steps.push({ label: label + '|issues', run: () => payloadsFor(tool, direction, version).map(p =>
          direction === 'request' ? validator.validateRequest(tool, p, version) : validator.validateResponse(tool, p, version)) });
      };
      const canonical = () => steps.push({ label: label + '|canonical', run: () => {
        const fn = loader.getCanonicalToolValidatorForVersion(tool, direction, version);
        if (!fn) return null;
        return { schema: digest(fn.schema), frozen: Object.isFrozen(fn.schema), props: Object.getOwnPropertyNames(fn).sort(),
                 outcomes: raw(fn, payloadsFor(tool, direction, version)) };
      } });
      if (cfg.only === 'canonical') canonical();
      else if (cfg.only === 'modular') modular();
      else if (cfg.reverse) { canonical(); modular(); }
      else { modular(); canonical(); }
    }
  }
  for (const ref of cfg.only ? [] : cfg.refs) {
    for (const allErrors of [false, true]) {
      steps.push({ label: version + '|ref|' + ref + '|' + allErrors, run: () => {
        const fn = loader.getSchemaValidatorByRef(ref, version, undefined, { allErrors });
        if (!fn) return null;
        const doc = loader.getSchemaDocumentByRef(ref, version);
        const properties = Object.keys((doc && doc.schema.properties) || {}).sort().slice(0, 12);
        const payloads = [{}, [], null, ...properties.flatMap(p => [7, {}, [{}]].map(v => ({ [p]: v })))];
        return { schema: digest(fn.schema), frozen: Object.isFrozen(fn.schema), props: Object.getOwnPropertyNames(fn).sort(),
                 outcomes: raw(fn, payloads) };
      } });
    }
  }
  if (!cfg.only) steps.push({ label: version + '|delivery-envelope', run: () => {
    const fn = loader.getMediaBuyDeliveryEnvelopeValidator(version);
    return fn ? raw(fn, [{}, { task_type: 'x' }, { result: 7 }]) : null;
  } });
  steps.push({ label: version + '|registeredIds', run: () => [...loader.getRegisteredSchemaIds(version)].sort() });
}

const results = [];
for (const step of steps) {
  const before = { ...counts };
  let value;
  try {
    value = step.run();
  } catch (error) {
    value = { threw: String(error && error.message) };
  }
  const delta = {};
  for (const key of Object.keys(counts)) delta[key] = counts[key] - before[key];
  results.push({ label: step.label, digest: digest(value), ...delta });
  if (cfg.resultFile) fs.appendFileSync(cfg.resultFile, JSON.stringify({ label: step.label, value }) + '\n');
}
process.stdout.write('\n@@RESULT@@' + JSON.stringify({ results, counts }) + '\n');
`;

/** Run the plan in a fresh process. `cacheDir` undefined leaves the variable unset. */
function runChild({
  cacheDir,
  reverse = false,
  tools = TOOLS,
  versions = VERSIONS,
  only,
  externalRoots,
  extraPayloads,
  maxMb,
} = {}) {
  const resultFile = path.join(privateDir('results'), 'results.ndjson');
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PLAN: JSON.stringify({
      sdkRoot: SDK_ROOT,
      cacheDir,
      reverse,
      tools,
      versions,
      only,
      externalRoots,
      extraPayloads,
      resultFile,
      refs: REFS,
    }),
  };
  delete env.ADCP_VALIDATOR_CACHE_DIR;
  delete env.ADCP_VALIDATOR_CACHE_MAX_MB;
  if (cacheDir !== undefined) env.ADCP_VALIDATOR_CACHE_DIR = cacheDir;
  if (maxMb !== undefined) env.ADCP_VALIDATOR_CACHE_MAX_MB = String(maxMb);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', CHILD], { cwd: SDK_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', reject);
    child.on('close', status => {
      const line = stdout.split('\n').find(l => l.startsWith('@@RESULT@@'));
      if (status !== 0 || !line) return reject(new Error(`child exited ${status}: ${stderr}`));
      const parsed = JSON.parse(line.slice('@@RESULT@@'.length));
      parsed.byLabel = Object.fromEntries(parsed.results.map(r => [r.label, r]));
      parsed.resultFile = resultFile;
      resolve(parsed);
    });
  });
}

/** The first label whose value differs between two runs, with both values, or undefined. */
function firstDifference(a, b) {
  for (const r of a.results) {
    const other = b.byLabel[r.label];
    if (!other || other.digest !== r.digest) {
      const read = run =>
        fs
          .readFileSync(run.resultFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line))
          .find(entry => entry.label === r.label);
      return { label: r.label, a: JSON.stringify(read(a)).slice(0, 1500), b: JSON.stringify(read(b)).slice(0, 1500) };
    }
  }
  if (a.results.length !== b.results.length) return { label: '(step count)', a: a.results.length, b: b.results.length };
  return undefined;
}

function assertSameOutcomes(run, reference, context) {
  const difference = firstDifference(reference, run);
  assert.equal(difference, undefined, `${context}: ${JSON.stringify(difference, null, 1)}`);
}

const compiles = r => r.compile + r.compileSchemaEnv;

/** An external root for `version` with `files` (root-relative path -> document or raw JSON text). */
function fixtureRoot(label, version, files) {
  const root = path.join(privateDir(`root-${label}`), version);
  for (const [rel, document] of Object.entries({ 'index.json': { adcp_version: version }, ...files })) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof document === 'string' ? document : JSON.stringify(document));
  }
  return root;
}

/** The value a run recorded for one step. */
function stepValue(run, label) {
  return fs
    .readFileSync(run.resultFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .find(entry => entry.label === label).value;
}

/** Stored validator entries (`.js`) in a cache dir. */
function entryFiles(dir) {
  const entries = path.join(dir, 'v1');
  return fs.existsSync(entries)
    ? fs
        .readdirSync(entries)
        .filter(name => name.endsWith('.js'))
        .map(name => path.join(entries, name))
    : [];
}

/** A private copy of a cache dir, with the modes the cache accepts. */
function copyCache(from, label) {
  const dir = privateDir(label);
  fs.cpSync(from, dir, { recursive: true });
  fs.chmodSync(path.join(dir, 'v1'), 0o700);
  for (const name of fs.readdirSync(path.join(dir, 'v1'))) fs.chmodSync(path.join(dir, 'v1', name), 0o600);
  return dir;
}

/** A copy of a packaged release root. */
function copyRoot(version, label) {
  const root = path.join(privateDir(`root-${label}`), version);
  fs.cpSync(path.join(SDK_ROOT, 'schemas/cache', version), root, { recursive: true });
  return root;
}

// ---------------------------------------------------------------- scenarios

before(() => {
  const dir = privateDir('main');
  const mixedDir = privateDir('mixed');
  scenario.main = (async () => {
    const off = runChild();
    const offReverse = runChild({ reverse: true });
    const cold = await runChild({ cacheDir: dir });
    const entriesAfterCold = entryFiles(dir).length;
    const warm = await runChild({ cacheDir: dir });
    const warmReverse = await runChild({ cacheDir: dir, reverse: true });
    return {
      off: await off,
      offReverse: await offReverse,
      cold,
      warm,
      warmReverse,
      dir,
      entriesAfterCold,
      entriesAfterWarm: entryFiles(dir).length,
    };
  })();
  // Half the tools cached, then the whole plan: hits and misses interleave in one state.
  scenario.mixed = (async () => {
    await runChild({ cacheDir: mixedDir, tools: TOOLS.filter((_, i) => i % 2 === 0) });
    return runChild({ cacheDir: mixedDir });
  })();
  for (const promise of Object.values(scenario)) promise.catch(() => {});
});

// ---------------------------------------------------------------- exactness

test('outcomes are identical cache off, cold and warm', async () => {
  const { off, cold, warm } = await scenario.main;
  const failing = off.results.filter(r => r.label.endsWith('|issues'));
  assert.ok(failing.length >= VERSIONS.length * TOOLS.length, 'the plan validates payloads for every tool');
  assertSameOutcomes(cold, off, 'cold');
  assertSameOutcomes(warm, off, 'warm');
});

test('outcomes are identical warm in another call order, against stock in that order', async () => {
  const { offReverse, warmReverse } = await scenario.main;
  assertSameOutcomes(warmReverse, offReverse, 'warm, reverse order');
});

test('outcomes are identical when hits and misses interleave in one state', async () => {
  const [{ off }, mixed] = await Promise.all([scenario.main, scenario.mixed]);
  assertSameOutcomes(mixed, off, 'mixed');
  assert.ok(
    mixed.results.some(r => r.label.endsWith('|get') && compiles(r) > 0),
    'the mixed run compiled the tools the first run did not store'
  );
});

test('a cold run compiles exactly what stock compiles', async () => {
  const { off, cold } = await scenario.main;
  for (const r of off.results)
    assert.deepEqual(
      [cold.byLabel[r.label].compile, cold.byLabel[r.label].compileSchemaEnv],
      [r.compile, r.compileSchemaEnv],
      r.label
    );
});

// ---------------------------------------------------------------- work counts

test('warm runs compile no tool validator, for valid and failing payloads alike', async () => {
  const { off, warm, warmReverse } = await scenario.main;
  const modular = off.results.filter(r => r.label.endsWith('|get') && r.compile === 0 && r.compileSchemaEnv > 0);
  const canonical = off.results.filter(r => r.label.endsWith('|canonical') && compiles(r) > 0);
  assert.ok(modular.length >= VERSIONS.length * TOOLS.length, `modular validators in the plan: ${modular.length}`);
  assert.ok(
    canonical.length >= VERSIONS.length * TOOLS.length,
    `canonical validators in the plan: ${canonical.length}`
  );
  for (const run of [warm, warmReverse]) {
    // The delivery-envelope projection keeps its own uncached Ajv (one per release).
    const compiled = run.results
      .filter(r => !r.label.endsWith('|delivery-envelope') && compiles(r) > 0)
      .map(r => `${r.label}: ${r.compile}+${r.compileSchemaEnv}`);
    assert.deepEqual(compiled, [], 'steps that compiled in a warm run');
  }
});

test('warm runs build no schema-ref registry: schema-ref validators register and compile nothing', async () => {
  const { off, warm, warmReverse } = await scenario.main;
  const refSteps = off.results.filter(r => r.label.includes('|ref|'));
  assert.ok(refSteps.length >= VERSIONS.length * REFS.length * 2, `schema-ref steps: ${refSteps.length}`);
  assert.ok(
    refSteps.some(r => r.addSchema > 0 && compiles(r) > 0),
    'cache off, the first schema-ref validator of a release builds its registry'
  );
  for (const run of [warm, warmReverse]) {
    const work = run.results
      .filter(r => r.label.includes('|ref|'))
      .filter(r => r.addSchema > 0 || compiles(r) > 0)
      .map(r => `${r.label}: addSchema ${r.addSchema}, compiles ${compiles(r)}`);
    assert.deepEqual(work, [], 'schema-ref steps that registered or compiled in a warm run');
  }
});

test('every entry lookup of a warm run is a hit, and the warm runs store nothing new', async () => {
  const { warm, warmReverse, dir, entriesAfterCold, entriesAfterWarm } = await scenario.main;
  assert.ok(entriesAfterCold > 0, `the cold run stored nothing in ${dir}`);
  assert.equal(entriesAfterWarm, entriesAfterCold, `new entries in ${dir}`);
  for (const run of [warm, warmReverse]) {
    assert.ok(run.counts.lookups > 0, 'the warm run read the cache');
    assert.equal(run.counts.evaluated, run.counts.lookups, 'every entry looked up was found and evaluated');
  }
});

// ---------------------------------------------------------------- function identity

test('each validator served from the cache is its own function: calling one leaves another errors alone', async () => {
  const dir = privateDir('own');
  const plan = { versions: ['3.0.25'], tools: ['create_media_buy', 'update_media_buy'], only: 'modular' };
  await runChild({ ...plan, cacheDir: dir });
  const CHECK = String.raw`
    const path = require('node:path');
    const { sdkRoot } = JSON.parse(process.env.PLAN);
    const loader = require(path.join(sdkRoot, 'dist/lib/validation/schema-loader.js'));
    const out = {};
    for (const getter of ['getValidator', 'getCanonicalToolValidatorForVersion']) {
      const a = loader[getter]('create_media_buy', 'request', '3.0.25');
      const b = loader[getter]('update_media_buy', 'request', '3.0.25');
      const again = loader[getter]('create_media_buy', 'request', '3.0.25');
      a({ packages: [{}] });
      const held = JSON.stringify(a.errors);
      b({ packages: [{ budget: 'x' }] });
      out[getter] = { distinct: a !== b, stable: a === again, untouched: JSON.stringify(a.errors) === held, failed: held !== 'null' };
    }
    process.stdout.write('\n@@RESULT@@' + JSON.stringify(out) + '\n');
  `;
  // The canonical entries come from a canonical run over the same tools.
  await runChild({ ...plan, only: 'canonical', cacheDir: dir });
  const out = await new Promise((resolve, reject) => {
    const env = { ...process.env, ADCP_VALIDATOR_CACHE_DIR: dir, PLAN: JSON.stringify({ sdkRoot: SDK_ROOT }) };
    const child = spawn(process.execPath, ['-e', CHECK], { cwd: SDK_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('close', status => {
      const line = stdout.split('\n').find(l => l.startsWith('@@RESULT@@'));
      if (status !== 0 || !line) return reject(new Error(`child exited ${status}: ${stderr}`));
      resolve(JSON.parse(line.slice('@@RESULT@@'.length)));
    });
  });
  for (const getter of ['getValidator', 'getCanonicalToolValidatorForVersion'])
    assert.deepEqual(out[getter], { distinct: true, stable: true, untouched: true, failed: true }, getter);
});

// ---------------------------------------------------------------- key coverage and damage

test('schema-ref validators of two files that mirror one $id stay two functions, warm too', async () => {
  // Releases mirror async-response documents under the same $id in two files.
  const version = '3.3.0-rc.3';
  const A = 'core/async-response-refs/creative/sync-creatives-async-response-submitted.json';
  const B = 'creative/sync-creatives-async-response-submitted.json';
  const MIRROR = String.raw`
    const path = require('node:path');
    const { sdkRoot, version, A, B } = JSON.parse(process.env.PLAN);
    const loader = require(path.join(sdkRoot, 'dist/lib/validation/schema-loader.js'));
    const a = loader.getSchemaValidatorByRef(A, version);
    const b = loader.getSchemaValidatorByRef(B, version);
    const docA = loader.getSchemaDocumentByRef(A, version).schema;
    const docB = loader.getSchemaDocumentByRef(B, version).schema;
    a({});
    const held = JSON.stringify(a.errors);
    b({ status: 'submitted', bogus: 1 });
    const out = { sameId: docA.$id === docB.$id, distinct: a !== b, ownSchemas: a.schema.allOf === docA.allOf && b.schema.allOf === docB.allOf,
                  untouched: JSON.stringify(a.errors) === held && held !== 'null' };
    process.stdout.write('\n@@RESULT@@' + JSON.stringify(out) + '\n');
  `;
  const dir = privateDir('mirror');
  const run = () =>
    new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        ADCP_VALIDATOR_CACHE_DIR: dir,
        PLAN: JSON.stringify({ sdkRoot: SDK_ROOT, version, A, B }),
      };
      const child = spawn(process.execPath, ['-e', MIRROR], { cwd: SDK_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => (stdout += chunk));
      child.stderr.on('data', chunk => (stderr += chunk));
      child.on('close', status => {
        const line = stdout.split('\n').find(l => l.startsWith('@@RESULT@@'));
        if (status !== 0 || !line) return reject(new Error(`child exited ${status}: ${stderr}`));
        resolve(JSON.parse(line.slice('@@RESULT@@'.length)));
      });
    });
  const expected = { sameId: true, distinct: true, ownSchemas: true, untouched: true };
  assert.deepEqual(await run(), expected, 'cold');
  assert.deepEqual(await run(), expected, 'warm');
});

test('a referenced document edited in place is a miss: the next process validates against the new content', async () => {
  const version = '3.0.25';
  const root = copyRoot(version, 'edited');
  const dir = privateDir('edited-cache');
  const request = {
    signal_agent_segment_id: 'seg_1',
    idempotency_key: '7f0c1f9e-3c1a-4b8e-9d1e-2b8f6f5a4c3d',
    destinations: [{ type: 'platform', platform: 'dsp1' }],
  };
  const plan = {
    versions: [version],
    tools: ['activate_signal'],
    externalRoots: [[version, root]],
    extraPayloads: [request],
  };
  const original = await runChild({ ...plan, cacheDir: dir });
  // Only the referenced core document changes: same path, same $id.
  const file = path.join(root, 'core/destination.json');
  const destination = JSON.parse(fs.readFileSync(file, 'utf8'));
  destination.oneOf[0].properties.platform.maxLength = 2;
  fs.writeFileSync(file, JSON.stringify(destination));
  const [off, after] = await Promise.all([runChild(plan), runChild({ ...plan, cacheDir: dir })]);
  assertSameOutcomes(after, off, 'edited root');
  const label = `${version}|activate_signal|request`;
  assert.notEqual(
    off.byLabel[`${label}|issues`].digest,
    original.byLabel[`${label}|issues`].digest,
    'the edit changes the outcome'
  );
  assert.ok(compiles(after.byLabel[`${label}|get`]) > 0, 'the modular validator compiles against the edited root');
  assert.ok(
    compiles(after.byLabel[`${label}|canonical`]) > 0,
    'the canonical validator compiles against the edited root'
  );
});

test('origins of document roots Ajv compiles while resolving references are served too', async () => {
  // The request refers to b#/definitions/x and to all of c. Resolving the first
  // compiles b's own root, whose reference compiles c#/properties/a: an origin
  // at a deeper prefix than the request's own functions register, which the
  // issue for c.a reports (`#/type`, not `#/properties/a/type`).
  const version = '3.2.7';
  const base = `https://adcontextprotocol.org/schemas/${version}/`;
  const root = path.join(privateDir('root-side-effect'), version);
  const files = {
    'index.json': { adcp_version: version },
    'core/c.json': { $id: `${base}core/c.json`, type: 'object', properties: { a: { type: 'integer' } } },
    'core/b.json': {
      $id: `${base}core/b.json`,
      type: 'object',
      properties: { c: { $ref: `${base}core/c.json#/properties/a` } },
      definitions: { x: { type: 'string' } },
    },
    'media-buy/get-products-request.json': {
      $id: `${base}media-buy/get-products-request.json`,
      type: 'object',
      properties: { b: { $ref: `${base}core/b.json#/definitions/x` }, c: { $ref: `${base}core/c.json` } },
    },
  };
  for (const [rel, document] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), JSON.stringify(document));
  }
  const dir = privateDir('side-effect-cache');
  const plan = {
    versions: [version],
    tools: ['get_products'],
    only: 'modular',
    externalRoots: [[version, root]],
    extraPayloads: [{ b: 'ok', c: { a: 'not-an-int' } }],
  };
  const off = await runChild(plan);
  const label = `${version}|get_products|request|issues`;
  const issues = fs
    .readFileSync(off.resultFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .find(entry => entry.label === label)
    .value.at(-1).issues;
  assert.deepEqual(
    issues.map(issue => [issue.pointer, issue.schemaPath]),
    [['/c/a', '#/type']],
    'the fixture exercises the origin registered by c#/properties/a'
  );
  const cold = await runChild({ ...plan, cacheDir: dir });
  const warm = await runChild({ ...plan, cacheDir: dir });
  assertSameOutcomes(cold, off, 'cold');
  assertSameOutcomes(warm, off, 'warm');
  assert.equal(warm.counts.compileSchemaEnv + warm.counts.compile, 0, 'the warm run compiled nothing');
});

// Roots that each exercise one way a compile reaches beyond the validator's own functions.
const FIXTURES = {
  // The request refers to d#/definitions/a, which is only a $ref into e: Ajv
  // compiles d's root on the way, and d's root refers to c#/properties/a, an
  // origin deeper than the request's own functions register.
  'a $ref-only definition chain': base => ({
    'core/c.json': { $id: `${base}core/c.json`, type: 'object', properties: { a: { type: 'integer' } } },
    'core/e.json': { $id: `${base}core/e.json`, type: 'object', definitions: { b: { type: 'string' } } },
    'core/d.json': {
      $id: `${base}core/d.json`,
      type: 'object',
      properties: { q: { $ref: `${base}core/c.json#/properties/a` } },
      definitions: { a: { $ref: `${base}core/e.json#/definitions/b` } },
    },
    'media-buy/get-products-request.json': {
      $id: `${base}media-buy/get-products-request.json`,
      type: 'object',
      properties: { p: { $ref: `${base}core/d.json#/definitions/a` }, c: { $ref: `${base}core/c.json` } },
    },
  }),
  // A property name no JSON pointer can be URI-encoded with.
  'a property key with a lone surrogate': base => ({
    'core/c.json': { $id: `${base}core/c.json`, type: 'object', properties: { a: { type: 'integer' } } },
    'media-buy/get-products-request.json': `{"$id":"${base}media-buy/get-products-request.json","properties":{"\\ud800":{},"c":{"$ref":"${base}core/c.json"}}}`,
  }),
  // A tool document without $id: the canonical getter compiles it unregistered.
  'a tool document without $id': base => ({
    'core/c.json': { $id: `${base}core/c.json`, type: 'object', properties: { a: { type: 'integer' } } },
    'media-buy/get-products-request.json': { type: 'object', properties: { c: { $ref: `${base}core/c.json` } } },
  }),
};

for (const [name, files] of Object.entries(FIXTURES)) {
  test(`outcomes are identical cache off, cold and warm for ${name}`, async () => {
    const version = '3.2.7';
    const root = fixtureRoot(
      name.replace(/\W+/g, '-'),
      version,
      files(`https://adcontextprotocol.org/schemas/${version}/`)
    );
    const plan = {
      versions: [version],
      tools: ['get_products'],
      externalRoots: [[version, root]],
      extraPayloads: [{ p: 'ok', c: { a: 'x' } }, { p: 5 }],
    };
    const dir = privateDir('fixture-cache');
    const off = await runChild(plan);
    const cold = await runChild({ ...plan, cacheDir: dir });
    const warm = await runChild({ ...plan, cacheDir: dir });
    assertSameOutcomes(cold, off, 'cold');
    assertSameOutcomes(warm, off, 'warm');
  });
}

test('a recursive schema is served from the cache with its recursion intact', async () => {
  // `#` from a definition makes Ajv call the root through a holder object, and
  // a and b refer to each other, so one of them calls the other through Ajv's
  // wrapper for a function still being compiled.
  const version = '3.2.7';
  const base = `https://adcontextprotocol.org/schemas/${version}/`;
  const root = path.join(privateDir('root-recursive'), version);
  const files = {
    'index.json': { adcp_version: version },
    'media-buy/get-products-request.json': {
      $id: `${base}media-buy/get-products-request.json`,
      type: 'object',
      properties: {
        name: { type: 'string', enum: ['a', 'b'] },
        child: { $ref: '#' },
        node: { $ref: '#/definitions/a' },
      },
      definitions: {
        a: { type: 'object', properties: { b: { $ref: '#/definitions/b' }, up: { $ref: '#' } } },
        b: { type: 'object', properties: { a: { $ref: '#/definitions/a' }, v: { type: 'integer' } } },
      },
    },
  };
  for (const [rel, document] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), JSON.stringify(document));
  }
  const plan = {
    versions: [version],
    tools: ['get_products'],
    externalRoots: [[version, root]],
    extraPayloads: [
      { name: 'a', child: { name: 'b', child: { name: 'c', child: { name: 7 } } } },
      { node: { b: { a: { b: { v: 'x' } } }, up: { name: 'c', node: { up: { name: 7 } } } } },
    ],
  };
  const dir = privateDir('recursive-cache');
  const off = await runChild(plan);
  const [deep, cycle] = stepValue(off, `${version}|get_products|request|raw`).slice(-2);
  assert.deepEqual(
    deep.errors.map(e => e.instancePath),
    ['/child/child/name', '/child/child/child/name', '/child/child/child/name'],
    'the first payload fails three levels down'
  );
  assert.deepEqual(
    cycle.errors.map(e => e.instancePath),
    ['/node/b/a/b/v', '/node/up/name', '/node/up/node/up/name', '/node/up/node/up/name'],
    'the second payload fails through a, b, a, b and through # from a'
  );
  await runChild({ ...plan, cacheDir: dir });
  const warm = await runChild({ ...plan, cacheDir: dir });
  assertSameOutcomes(warm, off, 'warm, recursive schema');
  assert.equal(warm.counts.compile + warm.counts.compileSchemaEnv, 0, 'the warm run compiled nothing');
});

test('a root under a directory named mcp is no hit for the canonical getter: it throws as stock', async () => {
  // Canonical registration skips files whose path has an mcp segment, so
  // there the canonical validator cannot resolve its references.
  const version = '3.0.25';
  const plain = path.join(privateDir('root-plain'), version);
  const underMcp = path.join(privateDir('root-under'), 'mcp', version);
  for (const root of [plain, underMcp]) {
    fs.mkdirSync(path.dirname(root), { recursive: true });
    fs.cpSync(path.join(SDK_ROOT, 'schemas/cache', version), root, { recursive: true });
  }
  const dir = privateDir('mcp-cache');
  const plan = { versions: [version], tools: ['activate_signal'], only: 'canonical' };
  await runChild({ ...plan, externalRoots: [[version, plain]], cacheDir: dir });
  const off = await runChild({ ...plan, externalRoots: [[version, underMcp]] });
  const warm = await runChild({ ...plan, externalRoots: [[version, underMcp]], cacheDir: dir });
  assert.match(String(stepValue(off, `${version}|activate_signal|request|canonical`).threw), /can't resolve reference/);
  assertSameOutcomes(warm, off, 'warm, root under mcp');
});

test('envelope fields a process derived before an in-place edit never reach another process', async () => {
  // The loader derives a release's envelope fields once per root path and
  // process, so after an edit and re-registration this process still widens
  // the closed response root with the old task statuses. What it stores must
  // not be served to a process that reads the edited release fresh.
  const version = '3.2.7';
  const base = `https://adcontextprotocol.org/schemas/${version}/`;
  const root = path.join(privateDir('root-envelope'), version);
  const files = {
    'index.json': { adcp_version: version },
    'core/protocol-envelope.json': {
      $id: `${base}core/protocol-envelope.json`,
      type: 'object',
      properties: { status: { $ref: `${base}enums/task-status.json` }, context_id: { type: 'string' } },
    },
    'enums/task-status.json': { $id: `${base}enums/task-status.json`, type: 'string', enum: ['completed', 'working'] },
    'media-buy/get-products-response.json': {
      $id: `${base}media-buy/get-products-response.json`,
      type: 'object',
      additionalProperties: false,
      properties: { products: { type: 'array' } },
    },
  };
  for (const [rel, document] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), JSON.stringify(document));
  }
  const statusFile = path.join(root, 'enums/task-status.json');
  const EDIT = String.raw`
    const fs = require('node:fs');
    const path = require('node:path');
    const { sdkRoot, version, root, statusFile, edit } = JSON.parse(process.env.PLAN);
    const loader = require(path.join(sdkRoot, 'dist/lib/validation/schema-loader.js'));
    const validator = require(path.join(sdkRoot, 'dist/lib/validation/schema-validator.js'));
    const payload = { products: [], status: 'zzz_new' };
    loader.registerExternalSchemaRoot(version, root);
    const out = [validator.validateResponse('get_products', payload, version).valid];
    if (edit) {
      const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
      status.enum.push('zzz_new');
      fs.writeFileSync(statusFile, JSON.stringify(status));
      loader.registerExternalSchemaRoot(version, root);
      out.push(validator.validateResponse('get_products', payload, version).valid);
    }
    process.stdout.write('\n@@RESULT@@' + JSON.stringify(out) + '\n');
  `;
  const run = (cacheDir, edit) =>
    new Promise((resolve, reject) => {
      const env = { ...process.env, PLAN: JSON.stringify({ sdkRoot: SDK_ROOT, version, root, statusFile, edit }) };
      delete env.ADCP_VALIDATOR_CACHE_DIR;
      if (cacheDir) env.ADCP_VALIDATOR_CACHE_DIR = cacheDir;
      const child = spawn(process.execPath, ['-e', EDIT], { cwd: SDK_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => (stdout += chunk));
      child.stderr.on('data', chunk => (stderr += chunk));
      child.on('close', status => {
        const line = stdout.split('\n').find(l => l.startsWith('@@RESULT@@'));
        if (status !== 0 || !line) return reject(new Error(`child exited ${status}: ${stderr}`));
        resolve(JSON.parse(line.slice('@@RESULT@@'.length)));
      });
    });
  const dir = privateDir('envelope-cache');
  assert.deepEqual(await run(dir, true), [false, false], 'the editing process keeps the old statuses (stock)');
  assert.deepEqual(await run(undefined, false), [true], 'a fresh process accepts the new status (stock)');
  assert.deepEqual(await run(dir, false), [true], 'a fresh process with the cache accepts it too');
});

test('pruning keeps the directory near ADCP_VALIDATOR_CACHE_MAX_MB with far fewer scans than writes', async () => {
  // 512 entries of 8 KB into a 1 MB cache: four times the limit. A scan stats
  // every file, so the cache scans at its first write and then only every
  // eighth of the limit written or when it may be full, and prunes to seven
  // eighths, so a full directory is not scanned again on the next write.
  const dir = privateDir('prune');
  const PRUNE = String.raw`
    const fs = require('node:fs');
    const path = require('node:path');
    const { sdkRoot, dir } = JSON.parse(process.env.PLAN);
    const entries = path.join(dir, 'v1');
    let scans = 0;
    const readdirSync = fs.readdirSync;
    fs.readdirSync = function countingReaddir(target, ...rest) {
      if (target === entries) scans++;
      return readdirSync.call(this, target, ...rest);
    };
    const { openValidatorCache } = require(path.join(sdkRoot, 'dist/lib/validation/validator-cache.js'));
    const cache = openValidatorCache(dir, path.join(sdkRoot, 'dist/lib/validation/schema-loader.js'));
    const body = 'module.exports = function () { return true; };\n// ' + 'x'.repeat(8 * 1024);
    for (let i = 0; i < 512; i++) cache.write('entry-' + i, body, undefined);
    const sizes = fs.readdirSync(entries).map(name => fs.statSync(path.join(entries, name)).size);
    process.stdout.write('\n@@RESULT@@' + JSON.stringify({ scans, sizes }) + '\n');
  `;
  const { scans, sizes } = await new Promise((resolve, reject) => {
    const env = { ...process.env, ADCP_VALIDATOR_CACHE_MAX_MB: '1', PLAN: JSON.stringify({ sdkRoot: SDK_ROOT, dir }) };
    const child = spawn(process.execPath, ['-e', PRUNE], { cwd: SDK_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('close', status => {
      const line = stdout.split('\n').find(l => l.startsWith('@@RESULT@@'));
      if (status !== 0 || !line) return reject(new Error(`child exited ${status}: ${stderr}`));
      resolve(JSON.parse(line.slice('@@RESULT@@'.length)));
    });
  });
  const limit = 1024 * 1024;
  const total = sizes.reduce((a, b) => a + b, 0);
  assert.ok(scans * 8 < 512, `${scans} scans for 512 writes`);
  assert.ok(total <= limit + limit / 8 + Math.max(...sizes), `directory ${total} bytes for a ${limit}-byte limit`);
  assert.ok(total > limit / 2, `the directory keeps recent entries: ${total} bytes`);
});

test('an entry whose origin data no longer matches the release compiles live, with stock outcomes', async () => {
  const { off, dir } = await scenario.main;
  const damaged = copyCache(dir, 'damaged-meta');
  let rewritten = 0;
  for (const file of entryFiles(damaged)) {
    const text = fs.readFileSync(file, 'utf8');
    const newline = text.indexOf('\n');
    const header = JSON.parse(text.slice('// adcp-validator-cache '.length, newline));
    if (!header.meta) continue;
    const body = text.slice(newline + 1);
    const metaEnd = body.indexOf('\n');
    const meta = JSON.parse(body.slice(0, metaEnd));
    // Bundled entries list their origins; per-function entries carry one.
    const origins = Array.isArray(meta.origins) ? meta.origins : meta.origin ? [meta.origin] : [];
    if (origins.length === 0) continue;
    // A pointer the release does not have: well-formed, correctly hashed, unlocatable.
    for (const origin of origins) origin.pointer = `${origin.pointer}/not-in-the-release`;
    const next = JSON.stringify(meta) + body.slice(metaEnd);
    header.sha256 = crypto.createHash('sha256').update(next).digest('hex');
    fs.writeFileSync(file, `// adcp-validator-cache ${JSON.stringify(header)}\n${next}`);
    rewritten++;
  }
  assert.ok(rewritten > 0, 'entries with origin data');
  const run = await runChild({ cacheDir: damaged });
  assertSameOutcomes(run, off, 'unlocatable origin data');
  assert.ok(run.counts.compileSchemaEnv > 0, 'the damaged entries were compiled live');
});

test('a release whose documents have ambiguous identities still throws on the canonical getter, warm too', async () => {
  const version = '3.0.25';
  const root = copyRoot(version, 'ambiguous');
  // A second file declaring an existing $id with different content.
  const destination = JSON.parse(fs.readFileSync(path.join(root, 'core/destination.json'), 'utf8'));
  fs.writeFileSync(path.join(root, 'core/destination-copy.json'), JSON.stringify({ ...destination, title: 'Changed' }));
  const dir = privateDir('ambiguous-cache');
  const plan = { versions: [version], tools: ['activate_signal'], only: 'canonical', externalRoots: [[version, root]] };
  const off = await runChild(plan);
  const cold = await runChild({ ...plan, cacheDir: dir });
  const warm = await runChild({ ...plan, cacheDir: dir });
  const label = `${version}|activate_signal|request|canonical`;
  const read = run =>
    fs
      .readFileSync(run.resultFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
      .find(entry => entry.label === label).value;
  assert.match(String(read(off).threw), /unambiguous schema identities/);
  assertSameOutcomes(cold, off, 'cold');
  assertSameOutcomes(warm, off, 'warm');
  // The schema-ref getter: a warm run first has entries from the unchanged
  // release, then sees the conflicting copy and must still throw.
  const refsPlan = { versions: [version], tools: [], externalRoots: [[version, root]] };
  const plainRoot = copyRoot(version, 'unambiguous');
  const refsDir = privateDir('ambiguous-refs-cache');
  await runChild({ ...refsPlan, externalRoots: [[version, plainRoot]], cacheDir: refsDir });
  const [refsOff, refsWarm] = await Promise.all([runChild(refsPlan), runChild({ ...refsPlan, cacheDir: refsDir })]);
  assert.match(
    String(stepValue(refsOff, `${version}|ref|core/account-ref.json|false`).threw),
    /unambiguous schema identities/
  );
  assertSameOutcomes(refsWarm, refsOff, 'schema-ref getter, warm');
});
