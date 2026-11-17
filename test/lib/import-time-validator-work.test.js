// No package entry point builds or fills an Ajv instance while it is being
// imported. Every SDK entry point is imported by every consumer file, so
// validator work at module scope is paid once per importing process even when
// nothing is validated; it belongs behind a first-use getter.
//
// Observed in one fresh child process that requires every entry point in turn
// and counts calls to Ajv.prototype.{addSchema, compile, validateSchema} on the
// SDK's own `ajv` dependency, attributing each call to the entry point whose
// require triggered it. The meta-test feeds a fixture that does such work at
// import and one that defers it, so a broken counter cannot pass the guard
// silently.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SDK_ROOT = path.resolve(__dirname, '../..');
const pkg = require('../../package.json');

const CHILD = String.raw`
const path = require('node:path');
const ajvModule = require(require.resolve('ajv', { paths: [process.env.SDK_ROOT] }));
const Ajv = ajvModule.default || ajvModule;
let current;
const observed = {};
for (const method of ['addSchema', 'compile', 'validateSchema']) {
  const original = Ajv.prototype[method];
  Ajv.prototype[method] = function countingAjvMethod(...args) {
    const entry = (observed[current] ??= { calls: 0, sites: [] });
    entry.calls++;
    if (entry.sites.length < 3) entry.sites.push(method + ': ' + new Error().stack.split('\n').slice(2, 6).join(' <- '));
    return original.apply(this, args);
  };
}
for (const entry of JSON.parse(process.env.ENTRIES)) {
  current = entry;
  require(path.resolve(process.env.SDK_ROOT, entry));
}
process.stdout.write(JSON.stringify(observed));
`;

/** Ajv calls made while requiring each entry point, keyed by entry; entries without any are absent. */
function ajvCallsWhileImporting(entries) {
  const child = spawnSync(process.execPath, ['-e', CHILD], {
    cwd: SDK_ROOT,
    env: { ...process.env, SDK_ROOT, ENTRIES: JSON.stringify(entries), NODE_ENV: 'test' },
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(child.status, 0, `child exited ${child.status}: ${child.stderr}`);
  return JSON.parse(child.stdout);
}

/** Every CommonJS JavaScript target in the package exports map. */
function exportedCommonJsEntries() {
  const entries = new Set();
  for (const target of Object.values(pkg.exports)) {
    const require = target && typeof target === 'object' ? target.require : undefined;
    const file = typeof require === 'string' ? require : require?.default;
    if (typeof file === 'string' && file.endsWith('.js')) entries.add(file);
  }
  return [...entries].sort();
}

let fixtureDir;
before(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-import-ajv-'));
  const ajvPath = JSON.stringify(require.resolve('ajv', { paths: [SDK_ROOT] }));
  fs.writeFileSync(
    path.join(fixtureDir, 'eager.js'),
    `const Ajv = require(${ajvPath}).default;\nconst ajv = new Ajv();\najv.addSchema({ $id: '/eager.json', type: 'string' });\n`
  );
  fs.writeFileSync(
    path.join(fixtureDir, 'lazy.js'),
    `const Ajv = require(${ajvPath}).default;\nlet ajv;\nexports.validate = value => (ajv ??= new Ajv()).validate({ type: 'string' }, value);\n`
  );
});
after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));

test('meta: a module that fills an Ajv instance at import is counted, and a deferring one is not', () => {
  const eager = path.join(fixtureDir, 'eager.js');
  const lazy = path.join(fixtureDir, 'lazy.js');
  const observed = ajvCallsWhileImporting([lazy, eager]);
  assert.ok(observed[eager]?.calls > 0, JSON.stringify(observed));
  assert.equal(observed[lazy], undefined, JSON.stringify(observed));
});

test('the exports map lists the entry points this guard covers', () => {
  const entries = exportedCommonJsEntries();
  assert.ok(entries.includes('./dist/lib/index.js'));
  assert.ok(entries.includes('./dist/lib/server/index.js'));
  assert.ok(entries.includes('./dist/lib/testing/index.js'));
});

test('importing any package entry point does no Ajv work', () => {
  const observed = ajvCallsWhileImporting(exportedCommonJsEntries());
  assert.deepEqual(observed, {}, `Ajv work at import:\n${JSON.stringify(observed, null, 2)}`);
});
