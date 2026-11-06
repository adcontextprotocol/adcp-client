const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { listBundles, resolveStoryboardsForCapabilities } = require('../../dist/lib/testing/storyboard/compliance.js');
const { buildComplianceBundleResults } = require('../../dist/lib/testing/compliance/comply.js');

const caps = { supported_protocols: [], supported_versions: ['3.2.6'] };
const storyboard = phases =>
  `id: executable\nversion: 1.0.0\ntitle: Executable\ncategory: test\nsummary: Test\nnarrative: Test\nagent:\n  interaction_model: '*'\n  capabilities: []\ncaller:\n  role: buyer_agent\nphases: ${phases}\n`;

test('universal metadata is excluded while empty placeholders and malformed coverage remain visible', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adcp-universal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'universal'));
  const universal = [
    'metadata-with-id',
    'metadata',
    'comment-guide',
    'empty',
    'missing-phases',
    'executable',
    'broken-yaml',
    'broken-phases',
    'broken-null',
    'missing',
  ];
  writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify({ adcp_version: '3.2.6', published_version: '3.2.6', universal, protocols: [], specialisms: [] })
  );
  const write = (name, content) => writeFileSync(path.join(dir, 'universal', `${name}.yaml`), content);
  write('metadata-with-id', 'id: governance\nrules: []\n');
  write('metadata', 'guide: supporting material\n');
  write('comment-guide', '# Storyboard definition guide\r\n# phases: array\r\n');
  write('empty', '');
  write('missing-phases', 'id: broken\nagent: {}\nphase: []\n');
  write('executable', storyboard('[]'));
  write('broken-yaml', 'private_example: do-not-log-this\nphases: [\n');
  write('broken-phases', storyboard('invalid'));
  write('broken-null', storyboard('null'));
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => warnings.push(String(message));
  try {
    const options = { version: '3.2.6', complianceDir: dir };
    const listed = listBundles(options).map(bundle => bundle.id);
    assert.deepEqual(listed, [
      'empty',
      'missing-phases',
      'executable',
      'broken-yaml',
      'broken-phases',
      'broken-null',
      'missing',
    ]);
    const resolved = resolveStoryboardsForCapabilities(caps, options);
    assert.deepEqual(
      resolved.bundles.map(bundle => bundle.ref.id),
      listed
    );
    assert.ok(resolved.storyboards.some(board => board.id === 'executable'));
    const grades = buildComplianceBundleResults(resolved.bundles, []);
    assert.ok(grades.every(bundle => bundle.status === 'untested'));
    assert.ok(warnings.some(message => message.includes('broken-yaml')));
    assert.ok(warnings.some(message => message.includes('broken-phases')));
    assert.ok(warnings.some(message => message.includes('broken-null')));
    assert.ok(warnings.some(message => message.includes('missing')));
    assert.ok(warnings.some(message => message.includes('empty')));
    assert.ok(!warnings.join('\n').includes('do-not-log-this'));
  } finally {
    console.warn = originalWarn;
  }
});

test('published 3.2.8 universal support documents do not become untested bundles', () => {
  const options = { version: '3.2.8', complianceDir: path.resolve(__dirname, '../../compliance/cache/3.2.8') };
  const resolved = resolveStoryboardsForCapabilities(caps, options);
  const metadata = [
    'buyer-fixture-publisher',
    'buyer-orchestrator-track',
    'fictional-entities',
    'governance',
    'runner-output-contract',
    'storyboard-schema',
    'v4-compatibility',
  ];
  const listed = listBundles(options)
    .filter(bundle => bundle.kind === 'universal')
    .map(bundle => bundle.id);
  for (const name of metadata) assert.ok(!listed.includes(name), `${name} is support material`);
  for (const name of metadata)
    assert.ok(!resolved.bundles.some(bundle => bundle.ref.kind === 'universal' && bundle.ref.id === name));
  assert.ok(listed.includes('signed-requests'), 'synthesized signed-request coverage remains listed');
});
