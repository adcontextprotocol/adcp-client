// With ADCP_VALIDATOR_CACHE_DIR set, a storyboard YAML document parsed by one
// process is read back by the next: the entry is keyed by the document's text,
// so a changed file is parsed again. Failures are never stored, and a document
// JSON cannot hold is parsed every time.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const COMPLIANCE = path.join(__dirname, '../../dist/lib/testing/storyboard/compliance.js');
const LOADER = path.join(__dirname, '../../dist/lib/testing/storyboard/loader.js');

function storyboardYaml(id, title, extra = '') {
  return `id: ${id}\nversion: 1.0.0\ntitle: ${title}\ncategory: test\nsummary: Test\nnarrative: Test\nagent:\n  interaction_model: '*'\n  capabilities: []\ncaller:\n  role: buyer_agent\nphases: []\n${extra}`;
}

// The aliased mapping is one object in the parsed document; `.inf` has no JSON form.
const ALIASED = 'shared_a: &shared { k: 1 }\nshared_b: *shared\n';
const INFINITE = 'limit: .inf\n';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-storyboard-yaml-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'universal'));
  fs.mkdirSync(path.join(dir, 'protocols', 'media-buy'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify({
      adcp_version: '3.2.7',
      universal: ['first', 'aliased', 'infinite'],
      protocols: [{ id: 'media-buy', has_baseline: true }],
      specialisms: [],
    })
  );
  fs.writeFileSync(path.join(dir, 'universal/first.yaml'), storyboardYaml('first', 'First'));
  fs.writeFileSync(path.join(dir, 'universal/aliased.yaml'), storyboardYaml('aliased', 'Aliased', ALIASED));
  fs.writeFileSync(path.join(dir, 'universal/infinite.yaml'), storyboardYaml('infinite', 'Infinite', INFINITE));
  fs.writeFileSync(path.join(dir, 'protocols/media-buy/index.yaml'), storyboardYaml('media_buy_baseline', 'Media buy'));
  return dir;
}

function cacheDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-storyboard-yaml-cache-dir-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Runs listAllComplianceStoryboards in a fresh process, counting YAML parses
// (yaml's parse and parseDocument), and returns the storyboards with the
// count. Non-finite numbers and shared objects are reported explicitly
// because JSON cannot carry them back to the test.
const CHILD = `
const yaml = require(process.env.YAML);
let parses = 0;
for (const name of ['parse', 'parseDocument']) {
  const original = yaml[name];
  yaml[name] = function (...args) { parses++; return original.apply(this, args); };
}
const { listAllComplianceStoryboards } = require(process.env.COMPLIANCE);
const storyboards = listAllComplianceStoryboards({ complianceDir: process.env.DIR, version: '3.2.7' });
const aliased = storyboards.find(sb => sb.id === 'aliased');
const infinite = storyboards.find(sb => sb.id === 'infinite');
const cacheCode = Object.keys(require.cache).some(file => file.endsWith('validator-cache.js'));
process.stdout.write(JSON.stringify({
  parses,
  cacheCode,
  aliasShared: aliased.shared_a === aliased.shared_b,
  infinite: infinite.limit === Infinity,
  storyboards,
}));
`;

function listInChild(dir, env) {
  const childEnv = { ...process.env, COMPLIANCE, YAML: require.resolve('yaml'), DIR: dir };
  delete childEnv.ADCP_VALIDATOR_CACHE_DIR;
  Object.assign(childEnv, env);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-storyboard-yaml-cache-cwd-'));
  try {
    const out = execFileSync(process.execPath, ['-e', CHILD], {
      cwd,
      env: childEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ...JSON.parse(out), cwdEntries: fs.readdirSync(cwd) };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test('a later process reads each storyboard document from the cache instead of parsing it', t => {
  const dir = fixture(t);
  const cache = cacheDir(t);
  const first = listInChild(dir, { ADCP_VALIDATOR_CACHE_DIR: cache });
  const second = listInChild(dir, { ADCP_VALIDATOR_CACHE_DIR: cache });
  assert.ok(first.parses > 0);
  // Only the `.inf` document is parsed again: once to classify the universal
  // file and once to load it.
  assert.equal(second.parses, 2);
  assert.deepEqual(second.storyboards, first.storyboards);
  assert.equal(second.aliasShared, true, 'aliases still share one object');
  assert.equal(second.infinite, true);
  assert.deepEqual(
    second.storyboards.map(sb => sb.id),
    ['first', 'aliased', 'infinite', 'media_buy_baseline']
  );
});

test('a changed storyboard file is parsed again', t => {
  const dir = fixture(t);
  const cache = cacheDir(t);
  listInChild(dir, { ADCP_VALIDATOR_CACHE_DIR: cache });
  fs.writeFileSync(path.join(dir, 'protocols/media-buy/index.yaml'), storyboardYaml('media_buy_baseline', 'Updated'));
  const after = listInChild(dir, { ADCP_VALIDATOR_CACHE_DIR: cache });
  assert.equal(after.parses, 3, 'the changed file and the .inf document twice');
  assert.equal(after.storyboards.find(sb => sb.id === 'media_buy_baseline').title, 'Updated');
});

test('without a cache directory every process parses and nothing is written', t => {
  const dir = fixture(t);
  for (const env of [{}, { ADCP_VALIDATOR_CACHE_DIR: '' }, { ADCP_VALIDATOR_CACHE_DIR: 'relative-cache' }]) {
    const first = listInChild(dir, env);
    const second = listInChild(dir, env);
    assert.equal(second.parses, first.parses, JSON.stringify(env));
    assert.equal(second.cacheCode, false, 'cache code loaded');
    assert.deepEqual(second.cwdEntries, [], 'files written to the working directory');
  }
});

test('invalid YAML throws the same error on every call and is never stored', t => {
  const cache = cacheDir(t);
  const previous = process.env.ADCP_VALIDATOR_CACHE_DIR;
  process.env.ADCP_VALIDATOR_CACHE_DIR = cache;
  t.after(() => {
    if (previous === undefined) delete process.env.ADCP_VALIDATOR_CACHE_DIR;
    else process.env.ADCP_VALIDATOR_CACHE_DIR = previous;
  });
  const { parseStoryboard } = require(LOADER);
  const messages = [];
  for (let i = 0; i < 2; i++) {
    assert.throws(
      () => parseStoryboard('id: broken\nphases: [\n'),
      err => {
        messages.push(err.message);
        return true;
      }
    );
  }
  assert.equal(messages[0], messages[1]);
  const entries = d => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }) : []);
  assert.deepEqual(
    entries(cache).filter(name => name.endsWith('.json')),
    [],
    'a failed parse left a cache entry'
  );
  // A valid document parses to fresh objects each call.
  const text = storyboardYaml('fresh', 'Fresh');
  const a = parseStoryboard(text);
  const b = parseStoryboard(text);
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.title = 'Mutated';
  assert.equal(parseStoryboard(text).title, 'Fresh');
});
