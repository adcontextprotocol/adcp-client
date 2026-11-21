// Opt-in cross-process cache for compiled bundled response validators
// (ADCP_VALIDATOR_CACHE_DIR).
//
// Contract:
//   - Unset, empty or relative: the SDK behaves exactly as it does without the
//     feature. It writes nothing anywhere and never loads the cache module.
//   - Absolute path: the first process compiles as stock and stores one entry
//     per bundled validator. A later process gets the same validators without
//     an Ajv compile. A failing payload compiles a validator once
//     (materialization) for the diagnostics lookup.
//   - Every outcome a caller can see (validateRequest/validateResponse results
//     incl. issue schemaId/schemaPath/discriminator/hint/allowedValues,
//     getRegisteredSchemaIds, validator.schema, fresh epochs on
//     re-registration, shared-$id identity) is identical cache off, cold and
//     warm.
//   - On any doubt (unsafe dir, symlinks, tampered or truncated entries) the
//     stock compile runs.
//
// Each scenario runs in a fresh child process. The child counts calls to
// Ajv.prototype.compile and Ajv.prototype._compileSchemaEnv on the SDK's own
// `ajv` dependency and every fs write the process makes. It also reports
// whether dist/lib/validation/validator-cache.js was ever loaded. Nothing
// under test is replaced. There are no wall-clock assertions.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ADCP_VERSION } = require('../../dist/lib/version');

const SDK_ROOT = path.resolve(__dirname, '../..');
const CACHE_MODULE = path.join(SDK_ROOT, 'dist/lib/validation/validator-cache.js');
const VERSIONS = [...new Set(['3.0.25', '3.1.31', '3.2.7', ADCP_VERSION])];
// Small bundled response tools (8-30 ms compiles each) that are bundled in
// every release after 3.0, so the file stays fast.
const TOOL_A = 'provide_performance_feedback';
const TOOL_B = 'activate_signal';

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- builders

/** A fresh private (0700) temp dir, realpath'd so no parent symlink (macOS /var) is involved. */
function privateDir(label) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `adcp-vcache-${label}-`)));
  fs.chmodSync(dir, 0o700);
  tempDirs.push(dir);
  return dir;
}

function activationResponse(activationKey) {
  return {
    status: 'completed',
    deployments: [{ type: 'platform', platform: 'dsp1', is_live: true, activation_key: activationKey }],
  };
}

/** Payloads by name. Each failing one has issues with discriminator, hint, allowedValues or schemaPath enrichment. */
const PAYLOADS = {
  activateValid: activationResponse({ type: 'key_value', key: 'k', value: 'v' }),
  // oneOf collapse on activation_key: discriminator + curated hint on the leaves.
  activateMissingKey: activationResponse({ type: 'key_value' }),
  // enum failure on the deployment type: allowedValues.
  activateBadType: {
    status: 'completed',
    deployments: [
      { type: 'nope', platform: 'dsp1', is_live: true, activation_key: { type: 'segment_id', segment_id: 's' } },
    ],
  },
  feedbackValid: { status: 'completed', success: true },
  feedbackWrongType: { status: 'completed', success: 'yes' },
  activateRequestValid: {
    idempotency_key: '7f0c1f9e-3c1a-4b8e-9d1e-2b8f6f5a4c3d',
    signal_agent_segment_id: 'seg_1',
    destinations: [{ type: 'platform', platform: 'dsp1' }],
  },
  activateRequestMissingKey: {
    signal_agent_segment_id: 'seg_1',
    destinations: [{ type: 'platform', platform: 'dsp1' }],
  },
  fixtureValid: { kind: 'a', items: [{ type: 'x', x: 's' }] },
  fixtureInvalid: { kind: 'c', items: [{ type: 'y' }] },
  fixtureKindC: { kind: 'c' },
};

/**
 * Steps for one version, in this order: get validator A, get validator B,
 * then validate a failing B payload (the sequence case: A is loaded, B fails),
 * a second failing B payload, B valid, A failing, A valid, a B enum failure,
 * requests (modular, out of the cache's scope but must stay identical),
 * registered ids and the validators' prepared schemas.
 */
function versionSteps(version, { requests = true } = {}) {
  const v = version;
  return [
    { op: 'getValidator', label: `${v}:A`, tool: TOOL_A, direction: 'sync', version: v },
    { op: 'getValidator', label: `${v}:B`, tool: TOOL_B, direction: 'sync', version: v },
    { op: 'validateResponse', label: `${v}:B:fail`, tool: TOOL_B, payload: 'activateMissingKey', version: v },
    { op: 'validateResponse', label: `${v}:B:fail-again`, tool: TOOL_B, payload: 'activateMissingKey', version: v },
    { op: 'validateResponse', label: `${v}:B:valid`, tool: TOOL_B, payload: 'activateValid', version: v },
    { op: 'validateResponse', label: `${v}:A:fail`, tool: TOOL_A, payload: 'feedbackWrongType', version: v },
    { op: 'validateResponse', label: `${v}:A:valid`, tool: TOOL_A, payload: 'feedbackValid', version: v },
    { op: 'validateResponse', label: `${v}:B:enum`, tool: TOOL_B, payload: 'activateBadType', version: v },
    ...(requests
      ? [
          { op: 'validateRequest', label: `${v}:req:valid`, tool: TOOL_B, payload: 'activateRequestValid', version: v },
          {
            op: 'validateRequest',
            label: `${v}:req:fail`,
            tool: TOOL_B,
            payload: 'activateRequestMissingKey',
            version: v,
          },
        ]
      : []),
    { op: 'registeredIds', label: `${v}:ids`, version: v },
    { op: 'schemaDigest', label: `${v}:A:schema`, tool: TOOL_A, direction: 'sync', version: v },
    { op: 'schemaDigest', label: `${v}:B:schema`, tool: TOOL_B, direction: 'sync', version: v },
  ];
}

const FULL_PLAN = VERSIONS.flatMap(v => versionSteps(v));
// Env and safety cases: one version, responses only.
const SMALL_PLAN = versionSteps('3.2.7', { requests: false });

const FIXTURE_VERSION = '3.2.7';
const FIXTURE_BASE = `https://adcontextprotocol.org/schemas/${FIXTURE_VERSION}/`;

/** A small bundled response schema: enum, root-local $ref, oneOf on a const discriminator. */
function fixtureSchema(id) {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: id,
    type: 'object',
    required: ['kind'],
    properties: {
      kind: { enum: ['a', 'b'] },
      items: { type: 'array', items: { $ref: '#/definitions/item' } },
    },
    definitions: {
      item: {
        oneOf: [
          { type: 'object', required: ['type', 'x'], properties: { type: { const: 'x' }, x: { type: 'string' } } },
          { type: 'object', required: ['type', 'y'], properties: { type: { const: 'y' }, y: { type: 'number' } } },
        ],
      },
    },
  };
}

/** A bundled-only external schema root. `files` maps root-relative paths to JSON documents. */
function writeFixtureRoot(label, files) {
  const root = privateDir(`root-${label}`);
  const all = { 'index.json': { adcp_version: FIXTURE_VERSION }, ...files };
  for (const [rel, document] of Object.entries(all)) {
    const file = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(document));
  }
  return root;
}

/**
 * Epoch steps: register a root, get its validator, rewrite one of its files
 * with the same bytes and register the root again (a fresh loader state and
 * generation, since the file is no longer settled), get the validator again.
 * Then a root whose two bundled tools share one root $id.
 */
function epochPlan(epochRoot, sharedRoot) {
  const v = FIXTURE_VERSION;
  return [
    { op: 'register', version: v, root: epochRoot },
    { op: 'generation', label: 'gen1' },
    { op: 'getValidator', label: 'epoch:v1', tool: 'get_products', direction: 'sync', version: v },
    { op: 'validateResponse', label: 'epoch:v1:fail', tool: 'get_products', payload: 'fixtureInvalid', version: v },
    { op: 'rewrite', path: path.join(epochRoot, 'bundled/media-buy/get-products-response.json') },
    { op: 'register', version: v, root: epochRoot },
    { op: 'generation', label: 'gen2' },
    { op: 'getValidator', label: 'epoch:v2', tool: 'get_products', direction: 'sync', version: v },
    { op: 'same', label: 'epoch:v1===v2', a: 'epoch:v1', b: 'epoch:v2' },
    { op: 'validateResponse', label: 'epoch:v2:fail', tool: 'get_products', payload: 'fixtureInvalid', version: v },
    { op: 'validateResponse', label: 'epoch:v2:valid', tool: 'get_products', payload: 'fixtureValid', version: v },
    { op: 'register', version: v, root: sharedRoot },
    { op: 'getValidator', label: 'shared:sync', tool: 'get_products', direction: 'sync', version: v },
    { op: 'getValidator', label: 'shared:request', tool: 'get_products', direction: 'request', version: v },
    { op: 'same', label: 'shared:sync===request', a: 'shared:sync', b: 'shared:request' },
    { op: 'validateRequest', label: 'shared:req:fail', tool: 'get_products', payload: 'fixtureInvalid', version: v },
    { op: 'validateResponse', label: 'shared:res:fail', tool: 'get_products', payload: 'fixtureInvalid', version: v },
    { op: 'registeredIds', label: 'shared:ids', version: v },
  ];
}

// ---------------------------------------------------------------- child process

const CHILD = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sdkRoot = process.env.SDK_ROOT;
const { plan, payloads } = JSON.parse(process.env.PLAN);

// Every fs write the process makes, by path. Installed before the SDK loads;
// the SDK reads fs members at call time, so these wrappers see its calls.
const writes = [];
const { O_WRONLY, O_RDWR, O_CREAT, O_APPEND, O_TRUNC } = fs.constants;
const writeFlag = flags =>
  typeof flags === 'number'
    ? (flags & (O_WRONLY | O_RDWR | O_CREAT | O_APPEND | O_TRUNC)) !== 0
    : typeof flags === 'string' && /[wax+]/.test(flags);
const tracked = {
  writeFileSync: () => true, appendFileSync: () => true, mkdirSync: () => true, mkdtempSync: () => true,
  renameSync: () => true, unlinkSync: () => true, rmSync: () => true, rmdirSync: () => true,
  utimesSync: () => true, lutimesSync: () => true, futimesSync: () => true, symlinkSync: () => true,
  linkSync: () => true, copyFileSync: () => true, cpSync: () => true, chmodSync: () => true,
  truncateSync: () => true, openSync: (file, flags) => writeFlag(flags),
};
for (const [name, isWrite] of Object.entries(tracked)) {
  const original = fs[name];
  if (typeof original !== 'function') continue;
  fs[name] = function trackedFsCall(...args) {
    if (isWrite(...args)) writes.push({ call: name, path: typeof args[0] === 'string' ? path.resolve(args[0]) : String(args[0]) });
    return original.apply(this, args);
  };
}

const ajvModule = require(require.resolve('ajv', { paths: [sdkRoot] }));
const Ajv = ajvModule.default || ajvModule;
const counts = { compile: 0, compileSchemaEnv: 0 };
// The JSON Schema meta-schema validator is compiled once per Ajv instance,
// by whichever compile runs first in it (Ajv checks every added schema
// against it). That is Ajv bookkeeping, not a validator compile, and with a
// warm cache it moves to the first materialization; it is not counted.
const isMetaSchemaEnv = sch => Boolean(sch && sch.meta);
for (const [method, key] of [['compile', 'compile'], ['_compileSchemaEnv', 'compileSchemaEnv']]) {
  const original = Ajv.prototype[method];
  Ajv.prototype[method] = function countingAjvMethod(...args) {
    if (!(method === '_compileSchemaEnv' && isMetaSchemaEnv(args[0]))) counts[key]++;
    return original.apply(this, args);
  };
}

const loader = require(path.join(sdkRoot, 'dist/lib/validation/schema-loader.js'));
const validator = require(path.join(sdkRoot, 'dist/lib/validation/schema-validator.js'));
const functions = {};
const results = [];
for (const step of plan) {
  const before = { ...counts };
  let value;
  switch (step.op) {
    case 'getValidator': {
      const fn = loader.getValidator(step.tool, step.direction, step.version);
      functions[step.label] = fn;
      value = { defined: typeof fn === 'function' };
      break;
    }
    case 'validateResponse':
      value = validator.validateResponse(step.tool, payloads[step.payload], step.version);
      break;
    case 'validateRequest':
      value = validator.validateRequest(step.tool, payloads[step.payload], step.version);
      break;
    case 'registeredIds':
      value = [...loader.getRegisteredSchemaIds(step.version)];
      break;
    case 'schemaDigest': {
      const fn = loader.getValidator(step.tool, step.direction, step.version);
      value = crypto.createHash('sha256').update(JSON.stringify(fn.schema)).digest('hex');
      break;
    }
    case 'register':
      loader.registerExternalSchemaRoot(step.version, step.root);
      break;
    case 'generation':
      value = loader.getSchemaLoaderGeneration();
      break;
    case 'same':
      value = functions[step.a] === functions[step.b];
      break;
    case 'touch':
      fs.writeFileSync(step.path, 'x');
      break;
    case 'rewrite':
      fs.writeFileSync(step.path, fs.readFileSync(step.path));
      break;
    default:
      throw new Error('unknown op ' + step.op);
  }
  results.push({
    label: step.label ?? step.op,
    op: step.op,
    value,
    compile: counts.compile - before.compile,
    compileSchemaEnv: counts.compileSchemaEnv - before.compileSchemaEnv,
  });
}
const cacheModuleLoaded = Object.prototype.hasOwnProperty.call(require.cache, process.env.CACHE_MODULE);
process.stdout.write('\n@@RESULT@@' + JSON.stringify({ results, writes, cacheModuleLoaded }) + '\n');
`;

/**
 * Run `plan` in a fresh Node process. `cacheDir`: undefined = env var unset;
 * any string (also '' or relative) is passed verbatim.
 */
function runChild(plan, { cacheDir, cwd = SDK_ROOT } = {}) {
  const env = {
    ...process.env,
    SDK_ROOT,
    CACHE_MODULE,
    NODE_ENV: 'test',
    PLAN: JSON.stringify({ plan, payloads: PAYLOADS }),
  };
  delete env.ADCP_VALIDATOR_CACHE_DIR;
  delete env.ADCP_VALIDATOR_CACHE_MAX_MB;
  if (cacheDir !== undefined) env.ADCP_VALIDATOR_CACHE_DIR = cacheDir;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', CHILD], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('error', reject);
    child.on('close', status => {
      clearTimeout(timer);
      const line = stdout.split('\n').find(l => l.startsWith('@@RESULT@@'));
      if (status !== 0 || !line) return reject(new Error(`child exited ${status}: ${stderr}`));
      const parsed = JSON.parse(line.slice('@@RESULT@@'.length));
      parsed.byLabel = Object.fromEntries(parsed.results.map(r => [r.label, r]));
      resolve(parsed);
    });
  });
}

// ---------------------------------------------------------------- observation helpers

/** Everything under `dir`: [{ rel, kind: 'file' | 'dir' | 'symlink' | 'other' }], sorted. */
function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const visit = (abs, rel) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const kind = entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other';
      out.push({ rel: childRel, kind });
      if (kind === 'dir') visit(path.join(abs, entry.name), childRel);
    }
  };
  visit(dir, '');
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Absolute paths of stored validator entries (regular `.js` files) under `dir`. */
function entryFiles(dir) {
  return walk(dir)
    .filter(e => e.kind === 'file' && e.rel.endsWith('.js'))
    .map(e => path.join(dir, ...e.rel.split('/')));
}

/** Step values only (no call counts), for differential comparison. */
function values(run) {
  return run.results.map(({ label, op, value }) => ({ label, op, value }));
}

/** Labels of getValidator steps that compiled through Ajv.prototype.compile in a cache-off run: bundled compiles. */
function bundledLabels(offRun) {
  return offRun.results.filter(r => r.op === 'getValidator' && r.compile > 0).map(r => r.label);
}

function isInside(file, dir) {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ---------------------------------------------------------------- scenarios
//
// All children start in `before`, independent ones concurrently; each test
// awaits only the scenario it reads.

const scenario = {};
before(() => {
  const missDir = path.join(privateDir('full'), 'cache'); // absent: the SDK creates it 0700
  const groupWritable = privateDir('group-writable');
  fs.chmodSync(groupWritable, 0o770);
  const symlinkTarget = privateDir('symlink-target');
  const symlinkHolder = privateDir('symlink-holder');
  const symlinkedDir = path.join(symlinkHolder, 'cache');
  fs.symlinkSync(symlinkTarget, symlinkedDir, 'dir');
  const relativeCwd = privateDir('relative-cwd');
  const epochRoot = writeFixtureRoot('epoch', {
    'bundled/media-buy/get-products-response.json': fixtureSchema(
      `${FIXTURE_BASE}media-buy/get-products-response.json`
    ),
  });
  const sharedId = `${FIXTURE_BASE}media-buy/get-products-response.json`;
  const sharedRoot = writeFixtureRoot('shared-id', {
    'bundled/media-buy/get-products-response.json': fixtureSchema(sharedId),
    'bundled/media-buy/get-products-request.json': { ...fixtureSchema(sharedId), required: ['kind', 'items'] },
  });
  const epochDir = privateDir('epoch-cache');
  const epoch = epochPlan(epochRoot, sharedRoot);
  const safetyWarmDir = privateDir('safety-warm');

  scenario.full = (async () => {
    const off = runChild(FULL_PLAN);
    const miss = await runChild(FULL_PLAN, { cacheDir: missDir });
    const entriesAfterMiss = entryFiles(missDir).length;
    const hit = await runChild(FULL_PLAN, { cacheDir: missDir });
    return { off: await off, miss, hit, missDir, entriesAfterMiss, entriesAfterHit: entryFiles(missDir).length };
  })();
  scenario.smallOff = runChild(SMALL_PLAN);
  scenario.empty = runChild(SMALL_PLAN, { cacheDir: '' });
  scenario.relative = runChild(SMALL_PLAN, { cacheDir: 'validator-cache', cwd: relativeCwd }).then(run => ({
    run,
    relativeCwd,
  }));
  scenario.groupWritable = runChild(SMALL_PLAN, { cacheDir: groupWritable }).then(run => ({ run, groupWritable }));
  scenario.symlinkedDir = runChild(SMALL_PLAN, { cacheDir: symlinkedDir }).then(run => ({
    run,
    symlinkTarget,
    symlinkedDir,
  }));
  scenario.epoch = (async () => {
    const off = runChild(epoch);
    const cold = await runChild(epoch, { cacheDir: epochDir });
    const warm = await runChild(epoch, { cacheDir: epochDir });
    return { off: await off, cold, warm, epochDir };
  })();
  // One warm dir; each safety case damages its own copy.
  scenario.safetyWarm = runChild(SMALL_PLAN, { cacheDir: safetyWarmDir }).then(run => ({
    run,
    dir: safetyWarmDir,
    entries: entryFiles(safetyWarmDir),
  }));
  // Keep unhandled rejections from surfacing before a test awaits them.
  for (const promise of Object.values(scenario)) promise.catch(() => {});
});

/** A private copy of the warm safety dir, or a failed assertion when the warm run stored nothing. */
async function damagedCopy(label) {
  const warm = await scenario.safetyWarm;
  assert.equal(
    warm.entries.length,
    2,
    `the warm run must have stored one entry per bundled validator (${TOOL_A}, ${TOOL_B}); found ${JSON.stringify(walk(warm.dir))}`
  );
  const dir = privateDir(`damaged-${label}`);
  fs.cpSync(warm.dir, dir, { recursive: true });
  for (const e of walk(dir)) {
    const abs = path.join(dir, ...e.rel.split('/'));
    fs.chmodSync(abs, e.kind === 'dir' ? 0o700 : 0o600);
  }
  return { dir, entries: entryFiles(dir) };
}

/** The stock compile ran for every bundled validator of a SMALL_PLAN run: same Ajv calls as cache off. */
function assertStockCompiles(run, offRun, context) {
  for (const label of bundledLabels(offRun)) {
    assert.equal(run.byLabel[label].compile, offRun.byLabel[label].compile, `${context}: ${label} compile calls`);
    assert.equal(
      run.byLabel[label].compileSchemaEnv,
      offRun.byLabel[label].compileSchemaEnv,
      `${context}: ${label} _compileSchemaEnv calls`
    );
  }
}

// ---------------------------------------------------------------- meta

test('meta: the child observes fs writes and bundled Ajv compiles', async () => {
  const dir = privateDir('meta');
  const file = path.join(dir, 'touched.txt');
  const run = await runChild([
    { op: 'touch', label: 'touch', path: file },
    { op: 'getValidator', label: 'compile', tool: TOOL_B, direction: 'sync', version: '3.2.7' },
  ]);
  assert.deepEqual(run.writes, [{ call: 'writeFileSync', path: file }]);
  assert.ok(run.byLabel.compile.compile > 0 && run.byLabel.compile.compileSchemaEnv > 0, JSON.stringify(run.byLabel));
});

// ---------------------------------------------------------------- env contract

test('env unset: no fs write anywhere and the cache module is never loaded', async () => {
  const { off } = await scenario.full;
  assert.equal(off.cacheModuleLoaded, false);
  assert.deepEqual(off.writes, []);
});

test('env empty string: cache off, no fs write and the cache module is never loaded', async () => {
  const [run, off] = await Promise.all([scenario.empty, scenario.smallOff]);
  assert.equal(run.cacheModuleLoaded, false);
  assert.deepEqual(run.writes, []);
  assert.deepEqual(values(run), values(off));
});

test('env relative path: ignored, nothing created under the cwd and the cache module is never loaded', async () => {
  const [{ run, relativeCwd }, off] = await Promise.all([scenario.relative, scenario.smallOff]);
  assert.equal(run.cacheModuleLoaded, false);
  assert.deepEqual(run.writes, []);
  assert.deepEqual(walk(relativeCwd), []);
  assert.deepEqual(values(run), values(off));
});

test('env absolute path: the cache module loads, the dir is created 0700 and one entry per bundled validator is stored', async () => {
  const { off, miss, hit, missDir, entriesAfterMiss, entriesAfterHit } = await scenario.full;
  const bundled = bundledLabels(off);
  assert.ok(bundled.length >= 6, `expected bundled response validators in 3.1+, got ${JSON.stringify(bundled)}`);
  assert.equal(miss.cacheModuleLoaded, true, 'the cache module is loaded when the env var is an absolute path');
  assert.ok(fs.existsSync(missDir), 'the cache dir is created');
  assert.equal(fs.lstatSync(missDir).mode & 0o777, 0o700, 'the cache dir is created with mode 0700');
  assert.equal(entriesAfterMiss, bundled.length, `one entry per bundled validator: ${JSON.stringify(walk(missDir))}`);
  assert.equal(entriesAfterHit, entriesAfterMiss, 'a warm run stores no new entries');
  for (const run of [miss, hit])
    for (const write of run.writes)
      assert.ok(isInside(write.path, missDir), `write outside the cache dir: ${JSON.stringify(write)}`);
});

// ---------------------------------------------------------------- exactness (guards)

test('outcomes are identical cache off, cold (miss) and warm (hit) for every bundled release', async () => {
  const { off, miss, hit } = await scenario.full;
  // Sanity: the plan exercises the enrichment fields this guard is about.
  const issues = off.results.flatMap(r => (r.value && Array.isArray(r.value.issues) ? r.value.issues : []));
  for (const field of ['schemaId', 'schemaPath', 'discriminator', 'hint', 'allowedValues'])
    assert.ok(
      issues.some(issue => issue[field] !== undefined),
      `no issue carries ${field}`
    );
  assert.ok(off.results.some(r => r.op === 'validateResponse' && r.value.valid === true));
  assert.deepEqual(values(miss), values(off), 'cold run differs from cache off');
  assert.deepEqual(values(hit), values(off), 'warm run differs from cache off');
});

test('a cold run compiles exactly what stock compiles', async () => {
  const { off, miss } = await scenario.full;
  for (const r of off.results)
    assert.deepEqual(
      [miss.byLabel[r.label].compile, miss.byLabel[r.label].compileSchemaEnv],
      [r.compile, r.compileSchemaEnv],
      r.label
    );
});

// ---------------------------------------------------------------- hit proof

test('warm run: bundled getValidator does no Ajv compile; a failing payload materializes its validator exactly once', async () => {
  const { off, hit } = await scenario.full;
  const bundled = bundledLabels(off);
  assert.ok(bundled.length >= 6, JSON.stringify(bundled));
  const zero = (label, why) =>
    assert.deepEqual(
      [hit.byLabel[label].compile, hit.byLabel[label].compileSchemaEnv],
      [0, 0],
      `${label}: ${why} (compile, _compileSchemaEnv)`
    );
  const stockCompile = label => [off.byLabel[label].compile, off.byLabel[label].compileSchemaEnv];
  for (const label of bundled) zero(label, 'a warm getValidator must not compile');
  for (const version of VERSIONS) {
    const v = version;
    if (!bundled.includes(`${v}:A`) || !bundled.includes(`${v}:B`)) continue;
    // Sequence: A was loaded, B fails: B (only) materializes, as one stock compile of B.
    assert.deepEqual(
      [hit.byLabel[`${v}:B:fail`].compile, hit.byLabel[`${v}:B:fail`].compileSchemaEnv],
      stockCompile(`${v}:B`),
      `${v}: the first failing ${TOOL_B} payload materializes its validator once`
    );
    zero(`${v}:B:fail-again`, 'a second failure reuses the materialized validator');
    zero(`${v}:B:valid`, 'a valid payload never materializes');
    assert.deepEqual(
      [hit.byLabel[`${v}:A:fail`].compile, hit.byLabel[`${v}:A:fail`].compileSchemaEnv],
      stockCompile(`${v}:A`),
      `${v}: the first failing ${TOOL_A} payload materializes its validator once`
    );
    zero(`${v}:A:valid`, 'a valid payload after materialization compiles nothing');
    zero(`${v}:B:enum`, 'another failure of a materialized validator compiles nothing');
  }
});

// ---------------------------------------------------------------- safety

test('a group-writable cache dir disables the cache: nothing written, stock compiles and outcomes', async () => {
  const [{ run, groupWritable }, off] = await Promise.all([scenario.groupWritable, scenario.smallOff]);
  assert.equal(fs.lstatSync(groupWritable).mode & 0o777, 0o770, 'the fixture dir is group-writable');
  assert.deepEqual(walk(groupWritable), []);
  assertStockCompiles(run, off, 'group-writable dir');
  assert.deepEqual(values(run), values(off));
});

test('a symlinked cache dir disables the cache: nothing written through the link, stock compiles and outcomes', async () => {
  const [{ run, symlinkTarget, symlinkedDir }, off] = await Promise.all([scenario.symlinkedDir, scenario.smallOff]);
  assert.equal(fs.lstatSync(symlinkedDir).isSymbolicLink(), true, 'the link itself is left alone');
  assert.deepEqual(walk(symlinkTarget), []);
  assertStockCompiles(run, off, 'symlinked dir');
  assert.deepEqual(values(run), values(off));
});

test('a same-length tampered entry body is never executed: stock compile and outcome, tampered bytes gone', async () => {
  const off = await scenario.smallOff;
  const { dir, entries } = await damagedCopy('tampered');
  const tampered = new Map();
  for (const file of entries) {
    const text = fs.readFileSync(file, 'utf8');
    const newline = text.indexOf('\n');
    assert.ok(newline > 0, `${file}: header line expected`);
    // "must ..." is the start of every Ajv error message the body builds;
    // executed tampered code would surface as upper-case issue messages.
    const body = text.slice(newline + 1).replaceAll('"must ', '"MUST ');
    const next = text.slice(0, newline + 1) + body;
    assert.notEqual(next, text, `${file}: nothing to tamper`);
    assert.equal(Buffer.byteLength(next), Buffer.byteLength(text), 'same length');
    fs.writeFileSync(file, next);
    tampered.set(file, next);
  }
  const run = await runChild(SMALL_PLAN, { cacheDir: dir });
  assertStockCompiles(run, off, 'tampered entries');
  assert.deepEqual(values(run), values(off));
  for (const [file, content] of tampered)
    assert.ok(!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content, `${file}: tampered entry kept`);
});

test('a truncated entry is ignored: stock compile and outcome', async () => {
  const off = await scenario.smallOff;
  const { dir, entries } = await damagedCopy('truncated');
  for (const file of entries) fs.truncateSync(file, Math.floor(fs.statSync(file).size / 2));
  const run = await runChild(SMALL_PLAN, { cacheDir: dir });
  assertStockCompiles(run, off, 'truncated entries');
  assert.deepEqual(values(run), values(off));
});

test('a symlinked entry is not followed: stock compile and outcome, link target untouched', async () => {
  const off = await scenario.smallOff;
  const { dir, entries } = await damagedCopy('symlinked-entry');
  const outside = privateDir('outside-entries');
  const targets = new Map();
  entries.forEach((file, i) => {
    const target = path.join(outside, `entry-${i}.js`);
    fs.renameSync(file, target);
    fs.symlinkSync(target, file);
    targets.set(target, fs.readFileSync(target));
  });
  const run = await runChild(SMALL_PLAN, { cacheDir: dir });
  assertStockCompiles(run, off, 'symlinked entries');
  assert.deepEqual(values(run), values(off));
  for (const [target, content] of targets)
    assert.deepEqual(fs.readFileSync(target), content, `${target} was written through the link`);
});

// ---------------------------------------------------------------- epoch and shared $id

test('re-registering a rewritten root yields a new validator and a generation bump, cache off, cold and warm', async () => {
  const { off, cold, warm } = await scenario.epoch;
  for (const [mode, run] of Object.entries({ off, cold, warm })) {
    assert.equal(run.byLabel['epoch:v1'].value.defined, true, mode);
    assert.equal(run.byLabel['epoch:v1===v2'].value, false, `${mode}: a re-registration must yield a new validator`);
    assert.ok(run.byLabel.gen2.value > run.byLabel.gen1.value, `${mode}: generation bump`);
    assert.equal(run.byLabel['shared:sync===request'].value, true, `${mode}: shared root $id -> one validator object`);
  }
  assert.ok(off.byLabel['epoch:v1:fail'].value.issues.some(issue => issue.allowedValues));
  assert.deepEqual(values(cold), values(off), 'cold run differs from cache off');
  assert.deepEqual(values(warm), values(off), 'warm run differs from cache off');
});

test('warm run serves both epochs and the shared-$id keys without an Ajv compile, as fresh functions per state', async () => {
  const { off, warm, epochDir } = await scenario.epoch;
  assert.ok(entryFiles(epochDir).length >= 1, `the cold run stored nothing: ${JSON.stringify(walk(epochDir))}`);
  for (const label of ['epoch:v1', 'epoch:v2', 'shared:sync', 'shared:request']) {
    assert.ok(off.byLabel[label].compile > 0 || label === 'shared:request', `${label} is a bundled compile on stock`);
    assert.deepEqual(
      [warm.byLabel[label].compile, warm.byLabel[label].compileSchemaEnv],
      [0, 0],
      `${label}: served from the warm cache (compile, _compileSchemaEnv)`
    );
  }
  assert.equal(warm.byLabel['epoch:v1===v2'].value, false, 'each state gets its own function object');
  assert.equal(warm.byLabel['shared:sync===request'].value, true);
});

// ---------------------------------------------------------------- key coverage
//
// The key digests the prepared schema itself (plus the SDK version, the loader
// code, the Ajv / ajv-formats / Ajv runtime dependency versions and the Ajv
// options), not the root path, so a schema edited in place at the same path
// is a different key: the next process compiles the new schema rather than
// loading the old validator.

test('a schema edited in place is a cache miss: the next process validates against the new schema, never the stored one', async () => {
  const id = `${FIXTURE_BASE}media-buy/get-products-response.json`;
  const rel = 'bundled/media-buy/get-products-response.json';
  const root = writeFixtureRoot('edited', { [rel]: fixtureSchema(id) });
  const dir = privateDir('edited-cache');
  const plan = [
    { op: 'register', version: FIXTURE_VERSION, root },
    { op: 'getValidator', label: 'v', tool: 'get_products', direction: 'sync', version: FIXTURE_VERSION },
    {
      op: 'validateResponse',
      label: 'kind-c',
      tool: 'get_products',
      payload: 'fixtureKindC',
      version: FIXTURE_VERSION,
    },
  ];
  const before = await runChild(plan, { cacheDir: dir });
  assert.equal(before.byLabel['kind-c'].value.valid, false, 'the original schema rejects kind c');
  const storedBefore = entryFiles(dir).length;
  assert.ok(storedBefore >= 1, 'the first run stored the validator');

  // Same path, same root, same $id: only the enum changes.
  const edited = fixtureSchema(id);
  edited.properties.kind.enum = ['a', 'b', 'c'];
  fs.writeFileSync(path.join(root, ...rel.split('/')), JSON.stringify(edited));

  const off = await runChild(plan);
  const after = await runChild(plan, { cacheDir: dir });
  assert.equal(off.byLabel['kind-c'].value.valid, true, 'stock accepts kind c under the edited schema');
  assert.deepEqual(values(after), values(off), 'the cached run matches stock on the edited schema');
  assert.ok(after.byLabel.v.compile > 0, 'the edited schema is compiled, not loaded');
  assert.equal(entryFiles(dir).length, storedBefore + 1, 'the edited schema is stored under a new key');
});
