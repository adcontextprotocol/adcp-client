'use strict';
// The validator cache keeps V8's code cache for each stored validator module
// in a sidecar beside the entry, so a later process evaluates the module
// without parsing it again. The first process that reads an entry writes the
// sidecar; every later process passes it to V8 and V8 accepts it. A sidecar
// that is damaged, belongs to another entry or to another runtime is never
// passed to V8: the module compiles from source and the sidecar is replaced.
// Validation outcomes are the same in every case.
//
// Each run is a fresh child process. The child counts vm.Script constructions
// for files in the cache directory: with cached data V8 accepted, with cached
// data V8 rejected, and without. Nothing under test is replaced.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SDK_ROOT = path.resolve(__dirname, '../..');
// Small tools whose response schemas are bundled in these releases (see validator-cache.test.js).
const TOOLS = ['provide_performance_feedback', 'activate_signal'];
const VERSIONS = ['3.1.31', '3.2.7'];
const PAYLOADS = [
  { status: 'completed', success: true },
  { status: 'completed', success: 'yes' },
  { status: 'completed', deployments: [{ type: 'nope', platform: 'dsp1', is_live: true }] },
];

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function privateDir(label) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `adcp-vcode-${label}-`)));
  fs.chmodSync(dir, 0o700);
  tempDirs.push(dir);
  return dir;
}

const CHILD = `
const path = require('node:path');
const vm = require('node:vm');
const { sdkRoot, cacheDir, tools, versions, payloads } = JSON.parse(process.env.PLAN);
const scripts = { accepted: 0, rejected: 0, plain: 0 };
const Script = vm.Script;
vm.Script = class CountingScript extends Script {
  constructor(code, options) {
    super(code, options);
    if (options && typeof options.filename === 'string' && options.filename.startsWith(cacheDir)) {
      if (!options.cachedData) scripts.plain++;
      else if (this.cachedDataRejected) scripts.rejected++;
      else scripts.accepted++;
    }
  }
};
const validator = require(path.join(sdkRoot, 'dist/lib/validation/schema-validator.js'));
const results = [];
for (const version of versions)
  for (const tool of tools)
    for (const payload of payloads) results.push(validator.validateResponse(tool, payload, version));
process.stdout.write('\\n@@RESULT@@' + JSON.stringify({ results, scripts }) + '\\n');
`;

function runChild(cacheDir) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PLAN: JSON.stringify({
      sdkRoot: SDK_ROOT,
      cacheDir: cacheDir ?? '\0',
      tools: TOOLS,
      versions: VERSIONS,
      payloads: PAYLOADS,
    }),
  };
  delete env.ADCP_VALIDATOR_CACHE_DIR;
  delete env.ADCP_VALIDATOR_CACHE_MAX_MB;
  if (cacheDir !== undefined) env.ADCP_VALIDATOR_CACHE_DIR = cacheDir;
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
      resolve(JSON.parse(line.slice('@@RESULT@@'.length)));
    });
  });
}

/** Files of the cache's entry directory with `suffix`. */
function cacheFiles(dir, suffix) {
  const out = [];
  for (const sub of fs.readdirSync(dir)) {
    const abs = path.join(dir, sub);
    if (!fs.statSync(abs).isDirectory()) continue;
    for (const name of fs.readdirSync(abs)) if (name.endsWith(suffix)) out.push(path.join(abs, name));
  }
  return out.sort();
}

/** A private copy of a cache dir, with modes the cache accepts. */
function copyCache(from, label) {
  const dir = privateDir(label);
  fs.cpSync(from, dir, { recursive: true });
  for (const sub of fs.readdirSync(dir)) {
    const abs = path.join(dir, sub);
    fs.chmodSync(abs, 0o700);
    for (const name of fs.readdirSync(abs)) fs.chmodSync(path.join(abs, name), 0o600);
  }
  return dir;
}

let warmed;
/** Cache off, then cold, first warm and second warm runs over one cache dir. */
function warmRuns() {
  warmed ??= (async () => {
    const dir = privateDir('runs');
    const off = await runChild(undefined);
    const cold = await runChild(dir);
    const entries = cacheFiles(dir, '.js');
    const first = await runChild(dir);
    const sidecars = cacheFiles(dir, '.v8');
    const second = await runChild(dir);
    return { dir, off, cold, entries, first, sidecars, second };
  })();
  return warmed;
}

test('a later process evaluates every cached validator module with V8 cached data V8 accepts', async () => {
  const { off, cold, entries, first, sidecars, second } = await warmRuns();
  assert.ok(entries.length >= 4, `expected an entry per bundled response validator, got ${entries.length}`);
  assert.deepEqual(cold.scripts, { accepted: 0, rejected: 0, plain: 0 }, 'a cold run compiles live');
  assert.deepEqual(first.scripts, { accepted: 0, rejected: 0, plain: entries.length }, 'first warm run');
  assert.equal(sidecars.length, entries.length, 'the first warm run writes one sidecar per entry');
  assert.deepEqual(second.scripts, { accepted: entries.length, rejected: 0, plain: 0 }, 'second warm run');
  for (const run of [cold, first, second]) assert.deepEqual(run.results, off.results);
});

/** Damage one sidecar in a copy of the warm cache, run once, and return the run and the copy. */
async function runWithDamagedSidecar(label, damage) {
  const { dir, sidecars } = await warmRuns();
  const copy = copyCache(dir, label);
  const target = path.join(copy, path.relative(dir, sidecars[0]));
  damage(target, copy);
  const run = await runChild(copy);
  return { run, next: await runChild(copy) };
}

for (const [label, damage] of [
  [
    'a flipped byte in the cached data',
    target => {
      const text = fs.readFileSync(target, 'utf8');
      const at = text.indexOf('\n') + 10;
      fs.writeFileSync(target, text.slice(0, at) + (text[at] === 'A' ? 'B' : 'A') + text.slice(at + 1));
    },
  ],
  [
    "another entry's sidecar",
    (target, copy) => {
      const other = cacheFiles(copy, '.v8').find(file => file !== target);
      fs.copyFileSync(other, target);
    },
  ],
  [
    'another runtime',
    target => {
      const text = fs.readFileSync(target, 'utf8');
      fs.writeFileSync(target, text.replace(/"runtime":"[^"]*"/, '"runtime":"v0.0.0 none 0.0"'));
    },
  ],
]) {
  test(`a sidecar with ${label} is never passed to V8: the module compiles from source, the sidecar is replaced`, async () => {
    const { off, entries } = await warmRuns();
    const { run, next } = await runWithDamagedSidecar(label.replace(/\W+/g, '-'), damage);
    assert.deepEqual(run.scripts, { accepted: entries.length - 1, rejected: 0, plain: 1 });
    assert.deepEqual(run.results, off.results);
    assert.deepEqual(
      next.scripts,
      { accepted: entries.length, rejected: 0, plain: 0 },
      'the replaced sidecar is accepted'
    );
    assert.deepEqual(next.results, off.results);
  });
}
