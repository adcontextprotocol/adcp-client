const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const root = path.resolve(__dirname, '..');

function compileFixture(schema, title) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-macro-string-'));
  const script = path.join(directory, 'harness.ts');
  const output = path.join(directory, 'output.txt');
  fs.writeFileSync(
    script,
    `
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { enforceStrictSchema } from ${JSON.stringify(path.join(root, 'scripts/generate-types.ts'))};
const { compile } = createRequire(${JSON.stringify(path.join(root, 'package.json'))})('json-schema-to-typescript');
async function main() {
  const normalized = enforceStrictSchema(${JSON.stringify(schema)});
  const result = await compile({ ...normalized, title: ${JSON.stringify(title)} }, ${JSON.stringify(title)});
  writeFileSync(${JSON.stringify(output)}, result);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
`
  );
  try {
    const result = spawnSync('npx', ['tsx', script], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return fs.readFileSync(output, 'utf8');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('the current signed macro URL schema emits a primitive string while retaining runtime validation', () => {
  const version = fs.readFileSync(path.join(root, 'ADCP_VERSION'), 'utf8').trim();
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'schemas/cache', version, 'core/macro-bearing-url.json')));
  const output = compileFixture(schema, 'MacroProbe');
  assert.match(output, /export type MacroProbe = string;/);
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  for (const value of [
    '',
    '{BASE_URL}/asset',
    '//example.test/asset',
    'https://example.test/asset',
    'https://example.test/asset?cb=[CACHEBUSTING]',
    'https://example.test/asset?cb=${CACHEBUSTER}',
    'https://example.test/asset?cb=%%CACHEBUSTER%%',
  ]) {
    assert.equal(validate(value), true, value);
  }
  for (const value of [42, {}, 'not a URL', 'https://example.test/has space'])
    assert.equal(validate(value), false, JSON.stringify(value));
});

test('primitive literal alternatives keep their value constraints', () => {
  const output = compileFixture({ type: 'string', anyOf: [{ const: 'a' }, { const: 'b' }] }, 'ValueConstraintProbe');
  assert.match(output, /["']a["']/);
  assert.match(output, /["']b["']/);
  assert.doesNotMatch(output, /export type ValueConstraintProbe = string;/);
});
