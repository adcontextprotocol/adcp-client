const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

function collect(schema, referencedFiles = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-wire-fields-'));
  const script = path.join(directory, 'harness.ts');
  const output = path.join(directory, 'output.json');
  for (const [relative, contents] of Object.entries(referencedFiles)) {
    const target = path.join(directory, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(contents));
  }
  fs.writeFileSync(
    script,
    `
import { writeFileSync } from 'node:fs';
import { collectTopLevelFields } from ${JSON.stringify(path.join(REPO_ROOT, 'scripts/wire-spec-field-collector.ts'))};
try {
  const fields = [...collectTopLevelFields(${JSON.stringify(schema)}, ${JSON.stringify(directory)}, new Set())].sort();
  writeFileSync(${JSON.stringify(output)}, JSON.stringify({ fields }));
} catch (error) {
  writeFileSync(${JSON.stringify(output)}, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}
`
  );
  try {
    const result = spawnSync('npx', ['tsx', script], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, `harness failed:\n${result.stderr}\n${result.stdout}`);
    return JSON.parse(fs.readFileSync(output, 'utf8'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('collects inherited fields through verified whole-document references', () => {
  assert.deepEqual(
    collect(
      { properties: { local: {} }, allOf: [{ $ref: 'core/envelope.json' }] },
      { 'core/envelope.json': { properties: { inherited: {} } } }
    ),
    { fields: ['inherited', 'local'] }
  );
});

test('rejects local and external fragment references instead of widening to a document root', () => {
  for (const ref of ['#/$defs/envelope', 'core/envelope.json#/$defs/envelope']) {
    const result = collect({ allOf: [{ $ref: ref }] }, { 'core/envelope.json': { properties: { unsafe: {} } } });
    assert.match(result.error, /refusing fragment schema reference/);
  }
});

test('rejects foreign origins, traversal, and missing cache documents', () => {
  const refs = ['https://example.com/schemas/core/envelope.json', '../secret.json', 'core/missing.json'];
  for (const ref of refs) {
    const result = collect({ allOf: [{ $ref: ref }] });
    assert.match(result.error, /refusing unsupported schema reference|absent from verified cache/);
  }
});
