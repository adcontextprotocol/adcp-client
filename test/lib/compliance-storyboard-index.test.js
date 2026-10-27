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

for (const source of ['explicit', 'environment']) {
  test(`refreshes a changed YAML in a ${source} custom root with the index untouched`, t => {
    const dir = fixture(t);
    if (source === 'environment') {
      const previous = process.env.ADCP_COMPLIANCE_DIR;
      process.env.ADCP_COMPLIANCE_DIR = dir;
      t.after(() => {
        if (previous === undefined) delete process.env.ADCP_COMPLIANCE_DIR;
        else process.env.ADCP_COMPLIANCE_DIR = previous;
      });
    }
    const options = { version: '3.2.7', ...(source === 'explicit' && { complianceDir: dir }) };
    const index = path.join(dir, 'index.json');
    const indexStat = fs.statSync(index);
    const first = getComplianceStoryboardById('example', options);
    assert.equal(first.title, 'Example');
    const yaml = path.join(dir, 'universal/example.yaml');
    const before = fs.statSync(yaml);
    fs.writeFileSync(yaml, fs.readFileSync(yaml, 'utf8').replace('title: Example', 'title: Updated'));
    fs.utimesSync(yaml, before.atime, before.mtime);
    const refreshed = getComplianceStoryboardById('example', options);
    assert.equal(refreshed.title, 'Updated');
    assert.equal(trustedStoryboardComplianceRoot(refreshed), dir);
    assert.equal(first.title, 'Example', 'prior detached results stay unchanged');
    assert.equal(fs.statSync(index).mtimeMs, indexStat.mtimeMs);
    assert.equal(fs.statSync(index).size, indexStat.size);
    const originalRead = fs.readFileSync;
    let yamlReads = 0;
    t.mock.method(fs, 'readFileSync', (...args) => {
      if (String(args[0]).startsWith(dir) && String(args[0]).endsWith('.yaml')) yamlReads++;
      return originalRead(...args);
    });
    assert.equal(getComplianceStoryboardById('example', options).title, 'Updated');
    assert.equal(yamlReads, 0, 'unchanged warm custom roots are not reparsed');
  });
}

test('refreshes synthesized steps after a custom signing vector changes without YAML or index edits', t => {
  const dir = fixture(t);
  const yaml = path.join(dir, 'universal/example.yaml');
  fs.writeFileSync(
    yaml,
    fs
      .readFileSync(yaml, 'utf8')
      .replace('id: example', 'id: signed_requests')
      .replace('phases: []', 'phases:\n  - id: positive_vectors\n    title: Positive vectors\n    steps: []')
  );
  const vectors = path.join(dir, 'test-vectors/request-signing');
  fs.cpSync(path.join(__dirname, '../../compliance/cache/3.2.7/test-vectors/request-signing'), vectors, {
    recursive: true,
  });
  const options = { complianceDir: dir, version: '3.2.7' };
  const first = getComplianceStoryboardById('signed_requests', options);
  assert.ok(first.phases[0].steps.length > 0);
  const profile = path.join(vectors, 'profile-3.2/positive');
  const vector = path.join(
    profile,
    fs
      .readdirSync(profile)
      .filter(file => file.endsWith('.json'))
      .sort()[0]
  );
  const data = JSON.parse(fs.readFileSync(vector, 'utf8'));
  data.name = 'Updated authoring vector';
  fs.writeFileSync(vector, JSON.stringify(data));
  const refreshed = getComplianceStoryboardById('signed_requests', options);
  assert.equal(refreshed.phases[0].steps[0].title, 'Positive: Updated authoring vector');
  assert.notEqual(first.phases[0].steps[0].title, refreshed.phases[0].steps[0].title);
});

test('missing custom roots retain the actionable cache diagnostic', t => {
  const dir = fixture(t);
  fs.rmSync(dir, { recursive: true });
  assert.throws(
    () => listAllComplianceStoryboards({ complianceDir: dir }),
    /Compliance cache.*not found.*npm i @adcp\/sdk@latest/s
  );
});
