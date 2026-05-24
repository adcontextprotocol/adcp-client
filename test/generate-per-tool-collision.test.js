const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

// Run the harness once; all tests share the results array.
const RESULTS = (() => {
  const harnessDir = fs.mkdtempSync(path.join(REPO_ROOT, '.per-tool-collision-'));
  const scriptPath = path.join(harnessDir, 'harness.ts');
  const outPath = path.join(harnessDir, 'out.json');
  const targetPath = path.join(REPO_ROOT, 'scripts/generate-per-tool-types.ts');

  const cases = [
    {
      label: 'jsdoc-only-difference',
      a: "/**\n * The type of financial commitment this outcome is for.\n */\nexport type PurchaseType = 'media_buy' | 'rights_license';",
      b: "/**\n * The type of financial commitment being governed.\n */\nexport type PurchaseType = 'media_buy' | 'rights_license';",
    },
    {
      label: 'structural-difference',
      a: "export type PurchaseType = 'media_buy' | 'rights_license';",
      b: "export type PurchaseType = 'media_buy' | 'rights_license' | 'added_value';",
    },
    {
      label: 'identical',
      a: "/**\n * Same doc.\n */\nexport type Foo = 'a' | 'b';",
      b: "/**\n * Same doc.\n */\nexport type Foo = 'a' | 'b';",
    },
    {
      // One source has JSDoc, other doesn't — asymmetric case; .trim() handles the
      // leading newline left behind after stripping the block comment.
      label: 'asymmetric-jsdoc',
      a: "/**\n * Description only in tools.generated.\n */\nexport type Foo = 'x' | 'y';",
      b: "export type Foo = 'x' | 'y';",
    },
  ];

  fs.writeFileSync(
    scriptPath,
    `
import { writeFileSync } from 'fs';
import { __test__ } from ${JSON.stringify(targetPath)};

const { stripComments } = __test__;
const cases = ${JSON.stringify(cases)};
const results = cases.map(({ label, a, b }) => ({
  label,
  strippedDiffer: stripComments(a).trim() !== stripComments(b).trim(),
}));
writeFileSync(${JSON.stringify(outPath)}, JSON.stringify(results));
`
  );

  try {
    const result = spawnSync('npx', ['tsx', scriptPath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`harness failed (${result.status}): ${result.stderr}\n${result.stdout}`);
    }
    return JSON.parse(fs.readFileSync(outPath, 'utf8'));
  } finally {
    fs.rmSync(harnessDir, { recursive: true, force: true });
  }
})();

test('stripComments: JSDoc-only difference does not make stripped bodies differ', () => {
  const jsdocCase = RESULTS.find(r => r.label === 'jsdoc-only-difference');
  assert.ok(jsdocCase, 'jsdoc-only-difference case should exist');
  assert.strictEqual(
    jsdocCase.strippedDiffer,
    false,
    'Bodies that differ only in JSDoc should compare equal after stripComments — no collision warning should fire'
  );
});

test('stripComments: structural type difference still makes stripped bodies differ', () => {
  const structCase = RESULTS.find(r => r.label === 'structural-difference');
  assert.ok(structCase, 'structural-difference case should exist');
  assert.strictEqual(
    structCase.strippedDiffer,
    true,
    'Bodies with different type members should still compare as different after stripComments'
  );
});

test('stripComments: identical bodies produce no difference', () => {
  const identCase = RESULTS.find(r => r.label === 'identical');
  assert.ok(identCase, 'identical case should exist');
  assert.strictEqual(identCase.strippedDiffer, false, 'Identical bodies should compare equal');
});

test('stripComments: asymmetric JSDoc (one body has it, other does not) produces no difference', () => {
  const asymCase = RESULTS.find(r => r.label === 'asymmetric-jsdoc');
  assert.ok(asymCase, 'asymmetric-jsdoc case should exist');
  assert.strictEqual(
    asymCase.strippedDiffer,
    false,
    'Bodies where only one has JSDoc should compare equal after stripComments + trim'
  );
});
