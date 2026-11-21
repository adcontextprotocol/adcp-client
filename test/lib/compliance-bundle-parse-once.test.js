// A compliance bundle's storyboard YAML is parsed once per compliance scope:
// the storyboard index and capability resolution share the parse, and both
// hand out detached copies.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  listAllComplianceStoryboards,
  resolveBundleOrStoryboard,
  resolveStoryboardsForCapabilities,
} = require('../../dist/lib/testing/storyboard/compliance');
const { trustedStoryboardComplianceRoot } = require('../../dist/lib/testing/storyboard/provenance');

function storyboardYaml(id, title) {
  return `id: ${id}\nversion: 1.0.0\ntitle: ${title}\ncategory: test\nsummary: Test\nnarrative: Test\nagent:\n  interaction_model: '*'\n  capabilities: []\ncaller:\n  role: buyer_agent\nphases: []\n`;
}

// Two universal bundles and one protocol baseline, so capability resolution
// selects a subset of what the index loads.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-bundle-parse-once-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'universal'));
  fs.mkdirSync(path.join(dir, 'protocols', 'media-buy'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify({
      adcp_version: '3.2.7',
      universal: ['first', 'second'],
      protocols: [{ id: 'media-buy', has_baseline: true }],
      specialisms: [],
    })
  );
  fs.writeFileSync(path.join(dir, 'universal/first.yaml'), storyboardYaml('first', 'First'));
  fs.writeFileSync(path.join(dir, 'universal/second.yaml'), storyboardYaml('second', 'Second'));
  fs.writeFileSync(path.join(dir, 'protocols/media-buy/index.yaml'), storyboardYaml('media_buy_baseline', 'Media buy'));
  return dir;
}

// Storyboard parses, counted as reads of a YAML file whose text is a storyboard.
function countParses(t, dir) {
  const counts = new Map();
  const originalRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (...args) => {
    const file = path.resolve(String(args[0]));
    if (file.startsWith(dir) && file.endsWith('.yaml')) {
      const rel = path.relative(dir, file);
      counts.set(rel, (counts.get(rel) ?? 0) + 1);
    }
    return originalRead(...args);
  });
  return counts;
}

const caps = { supported_protocols: ['media_buy'], specialisms: [], major_versions: [3] };

const yamlReads = parses => [...parses].reduce((sum, [, n]) => sum + n, 0);

test('capability resolution after the index reads no storyboard YAML again', t => {
  const dir = fixture(t);
  const options = { complianceDir: dir, version: '3.2.7' };
  assert.equal(listAllComplianceStoryboards(options).length, 3);
  const parses = countParses(t, dir);
  const resolved = resolveStoryboardsForCapabilities(caps, options);
  assert.deepEqual(resolved.storyboards.map(sb => sb.id).sort(), ['first', 'media_buy_baseline', 'second']);
  assert.deepEqual([...parses], [], 'YAML read again');
});

test('a relative compliance dir shares the same parse', t => {
  const dir = fixture(t);
  const relative = path.relative(process.cwd(), dir);
  assert.equal(listAllComplianceStoryboards({ complianceDir: dir, version: '3.2.7' }).length, 3);
  const parses = countParses(t, dir);
  resolveStoryboardsForCapabilities(caps, { complianceDir: relative, version: '3.2.7' });
  assert.equal(yamlReads(parses), 0, 'YAML read again through a relative path');
});

test('single-bundle resolution after the index reads no storyboard YAML again', t => {
  const dir = fixture(t);
  const options = { complianceDir: dir, version: '3.2.7' };
  listAllComplianceStoryboards(options);
  const parses = countParses(t, dir);
  const [bundle] = resolveBundleOrStoryboard('media-buy', options);
  assert.equal(bundle.id, 'media_buy_baseline');
  bundle.title = 'Caller mutation';
  assert.equal(resolveBundleOrStoryboard('media-buy', options)[0].title, 'Media buy');
  assert.equal(yamlReads(parses), 0);
});

test('the index after capability resolution parses only the bundles resolution did not load', t => {
  const dir = fixture(t);
  const options = { complianceDir: dir, version: '3.2.7' };
  resolveStoryboardsForCapabilities({ ...caps, supported_protocols: [] }, options);
  const parses = countParses(t, dir);
  assert.equal(listAllComplianceStoryboards(options).length, 3);
  assert.equal(parses.get('universal/first.yaml') ?? 0, 0, 'first reparsed');
  assert.equal(parses.get('universal/second.yaml') ?? 0, 0, 'second reparsed');
  assert.equal(parses.get('protocols/media-buy/index.yaml'), 1, 'the protocol bundle is parsed once');
});

test('resolved storyboards are detached copies that keep trusted provenance', t => {
  const dir = fixture(t);
  const options = { complianceDir: dir, version: '3.2.7' };
  const first = resolveStoryboardsForCapabilities(caps, options);
  const sb = first.storyboards.find(s => s.id === 'first');
  assert.equal(trustedStoryboardComplianceRoot(sb), dir);
  assert.ok(
    first.bundles.some(b => b.storyboards.includes(sb)),
    'bundles and storyboards share each copy'
  );
  sb.title = 'Caller mutation';
  first.bundles[0].storyboards.length = 0;
  const second = resolveStoryboardsForCapabilities(caps, options);
  assert.equal(second.storyboards.find(s => s.id === 'first').title, 'First');
  assert.ok(second.bundles[0].storyboards.length > 0);
  assert.equal(listAllComplianceStoryboards(options).find(s => s.id === 'first').title, 'First');
});

test('a changed YAML in a custom root is reparsed by capability resolution', t => {
  const dir = fixture(t);
  const options = { complianceDir: dir, version: '3.2.7' };
  assert.equal(resolveStoryboardsForCapabilities(caps, options).storyboards.find(s => s.id === 'first').title, 'First');
  const yaml = path.join(dir, 'universal/first.yaml');
  const before = fs.statSync(yaml);
  fs.writeFileSync(yaml, storyboardYaml('first', 'Updated'));
  fs.utimesSync(yaml, before.atime, before.mtime);
  assert.equal(
    resolveStoryboardsForCapabilities(caps, options).storyboards.find(s => s.id === 'first').title,
    'Updated'
  );
  assert.equal(listAllComplianceStoryboards(options).find(s => s.id === 'first').title, 'Updated');
});
