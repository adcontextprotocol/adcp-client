const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

function runHarness(source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-gap-schemas-'));
  const script = path.join(directory, 'harness.ts');
  const output = path.join(directory, 'output.json');
  fs.writeFileSync(
    script,
    source
      .replaceAll('__GENERATOR__', JSON.stringify(path.join(REPO_ROOT, 'scripts/generate-types.ts')))
      .replaceAll('__OUTPUT__', JSON.stringify(output))
  );
  try {
    const result = spawnSync('npx', ['tsx', script], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, `harness failed:\n${result.stderr}\n${result.stdout}`);
    return JSON.parse(fs.readFileSync(output, 'utf8'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('gap schemas read once, compile with bounded parallelism, and deduplicate in sorted order', () => {
  const result = runHarness(`
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { compileGapSchemas, GAP_SCHEMA_COMPILE_CONCURRENCY } from __GENERATOR__;

async function main() {
const relPaths = Array.from({ length: GAP_SCHEMA_COMPILE_CONCURRENCY + 2 }, (_, index) =>
  'enums/schema-' + String(GAP_SCHEMA_COMPILE_CONCURRENCY + 1 - index).padStart(2, '0') + '.json'
);
const readCounts = new Map<string, number>();
const compileOrder: string[] = [];
let active = 0;
let maximumActive = 0;
const output = await compileGapSchemas(new Set(['Generated01']), {}, {
  discoverSchemaFiles: () => relPaths,
  readSchema: schemaPath => {
    const relPath = schemaPath.slice(schemaPath.lastIndexOf('/enums/') + 1);
    readCounts.set(relPath, (readCounts.get(relPath) ?? 0) + 1);
    return { title: pathToTitle(relPath) };
  },
  compileSchema: async (_schema, typeName) => {
    compileOrder.push(typeName);
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return 'export type ' + typeName + ' = string;';
  },
  log: () => {},
  warn: () => {},
});
function pathToTitle(relPath: string) {
  return 'Generated ' + relPath.match(/schema-(\\d+)/)?.[1];
}
writeFileSync(__OUTPUT__, JSON.stringify({
  compileOrder,
  maximumActive,
  cap: GAP_SCHEMA_COMPILE_CONCURRENCY,
  readCounts: [...readCounts.entries()],
  output,
}));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
`);

  assert.equal(result.maximumActive, result.cap);
  assert.equal(result.compileOrder.length, result.cap + 1);
  assert.ok(!result.compileOrder.includes('Generated01'));
  assert.deepEqual(
    result.readCounts.map(([, count]) => count),
    Array(result.cap + 2).fill(1)
  );
  assert.match(result.output, /\/\/ enums\/schema-02\.json\nexport type Generated02 = string;/);
  assert.ok(result.output.indexOf('schema-02') < result.output.indexOf('schema-03'));
});

test('gap compilation logs only schemas over the slow threshold and reports total timing', () => {
  const result = runHarness(`
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { compileGapSchemas } from __GENERATOR__;

async function main() {
const logs: string[] = [];
const nowValues = [0, 100, 2101, 2500];
await compileGapSchemas(new Set(), {}, {
  discoverSchemaFiles: () => ['enums/slow.json'],
  readSchema: () => ({ title: 'Slow' }),
  compileSchema: async () => 'export type Slow = string;',
  now: () => nowValues.shift()!,
  log: message => logs.push(message),
  warn: message => logs.push(message),
});
writeFileSync(__OUTPUT__, JSON.stringify({ logs }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
`);

  assert.deepEqual(result.logs, [
    '🐢 Slow gap schema compilation: enums/slow.json (2001ms)',
    '📦 Compiled 1 gap schemas',
    '⏱️ Gap schema compilation completed in 2500ms',
  ]);
});

test('gap output keeps the first sorted title while compiling every duplicate schema', () => {
  const result = runHarness(`
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { compileGapSchemas } from __GENERATOR__;

async function main() {
let compileCount = 0;
const output = await compileGapSchemas(new Set(), {}, {
  discoverSchemaFiles: () => ['enums/z.json', 'enums/a.json', 'enums/m.json'],
  readSchema: schemaPath => ({
    title: path.basename(schemaPath, '.json') === 'z' ? 'Unique' : 'Same',
    description: path.basename(schemaPath, '.json'),
  }),
  compileSchema: async (schema, typeName) => {
    compileCount++;
    if (typeName === 'Same') {
      if (schema.description === 'a') {
        await new Promise(resolve => setTimeout(resolve, 20));
        return "export type Same = string;";
      }
      return "export type Same = string;\\nexport type LeakedAuxiliary = 'm';";
    }
    return "export type Unique = 'z';";
  },
  log: () => {},
  warn: () => {},
});
writeFileSync(__OUTPUT__, JSON.stringify({ compileCount, output }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
`);

  assert.equal(result.compileCount, 3);
  assert.match(result.output, /\/\/ enums\/a\.json\nexport type Same = string;/);
  assert.doesNotMatch(result.output, /enums\/m\.json/);
  assert.doesNotMatch(result.output, /LeakedAuxiliary/);
  assert.match(result.output, /\/\/ enums\/z\.json\nexport type Unique = 'z';/);
});
