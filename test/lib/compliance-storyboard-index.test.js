const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  getComplianceStoryboardById,
  listAllComplianceStoryboards,
} = require('../../dist/lib/testing/storyboard/compliance');
const { trustedStoryboardComplianceRoot } = require('../../dist/lib/testing/storyboard/provenance');
function fixture(t, title = 'Example') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-storyboard-index-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'universal'));
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify({ adcp_version: '3.2.7', universal: ['example'], protocols: [], specialisms: [] })
  );
  fs.writeFileSync(
    path.join(dir, 'universal/example.yaml'),
    `id: example\nversion: 1.0.0\ntitle: ${title}\ncategory: test\nsummary: Test\nnarrative: Test\nagent:\n  interaction_model: '*'\n  capabilities: []\ncaller:\n  role: buyer_agent\nphases: []\n`
  );
  return dir;
}
test('warm id lookups do not reparse the selected bundle and preserve trusted provenance', t => {
  const dir = fixture(t);
  const options = { complianceDir: dir, version: '3.2.7' };
  const originalRead = fs.readFileSync;
  let yamlReads = 0;
  t.mock.method(fs, 'readFileSync', (...args) => {
    if (String(args[0]).startsWith(dir) && String(args[0]).endsWith('.yaml')) yamlReads++;
    return originalRead(...args);
  });
  const first = getComplianceStoryboardById('example', options);
  assert.ok(yamlReads > 0);
  assert.equal(trustedStoryboardComplianceRoot(first), dir);
  yamlReads = 0;
  first.title = 'Caller mutation';
  first.phases.push({ id: 'caller-only', steps: [] });
  const second = getComplianceStoryboardById('example', options);
  assert.equal(second.title, 'Example');
  assert.deepEqual(second.phases, []);
  assert.equal(trustedStoryboardComplianceRoot(second), dir);
  assert.equal(yamlReads, 0);
  assert.equal(getComplianceStoryboardById('missing', options), undefined);
  const all = listAllComplianceStoryboards(options);
  all[0].title = 'List mutation';
  all.length = 0;
  assert.equal(listAllComplianceStoryboards(options)[0].title, 'Example');
  assert.equal(yamlReads, 0);
});
test('indexes are isolated by compliance root, schema root, release and hosted alias', t => {
  const a = fixture(t, 'Root A');
  const b = fixture(t, 'Root B');
  assert.equal(getComplianceStoryboardById('example', { complianceDir: a }).title, 'Root A');
  assert.equal(getComplianceStoryboardById('example', { complianceDir: b }).title, 'Root B');
  const originalRead = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', (...args) => {
    if (String(args[0]).startsWith(a) && String(args[0]).endsWith('.yaml')) reads++;
    return originalRead(...args);
  });
  for (const options of [
    { complianceDir: a, schemaRoot: a },
    { complianceDir: a, schemaRoot: b },
    { complianceDir: a, version: '3.2.7', hostedStableLineAlias: '3.2' },
    { complianceDir: a, version: '3.2.6', hostedStableLineAlias: '3.2' },
  ]) {
    const before = reads;
    assert.equal(getComplianceStoryboardById('example', options).title, 'Root A');
    assert.ok(reads > before, JSON.stringify(options));
  }
});
test('replacing a bundle index invalidates a cached root', t => {
  const dir = fixture(t);
  const options = { complianceDir: dir, version: '3.2.7' };
  assert.equal(getComplianceStoryboardById('example', options).title, 'Example');
  fs.writeFileSync(
    path.join(dir, 'universal/example.yaml'),
    fs.readFileSync(path.join(dir, 'universal/example.yaml'), 'utf8').replace('title: Example', 'title: Replaced')
  );
  const index = path.join(dir, 'index.json');
  fs.writeFileSync(index, fs.readFileSync(index, 'utf8') + '\n');
  assert.equal(getComplianceStoryboardById('example', options).title, 'Replaced');
});
