const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');

test('compatibility purchase input post-processing preserves following schema exports', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-zod-compat-purchase-'));
  const harness = path.join(directory, 'harness.ts');
  fs.writeFileSync(
    harness,
    `
import assert from 'node:assert/strict';
import { __test__ } from ${JSON.stringify(path.join(REPO_ROOT, 'scripts/generate-zod-from-ts.ts'))};

const input = [
  'export const CompatibilityPurchaseCoordinatorInputSchema = z.any();',
  'export const OutcomeTargetCostPerSchema = z.number();',
  'export const OutcomeTargetSchema = OutcomeTargetCostPerSchema;',
].join('\\n\\n');
const output = __test__.postProcessCompatibilityPurchaseCoordinatorInput(input);
assert.match(output, /CompatibilityPurchaseCoordinatorInputSchema = z\\.object\\(/);
assert.match(output, /export const OutcomeTargetCostPerSchema = z\\.number\\(\\);/);
assert.match(output, /export const OutcomeTargetSchema = OutcomeTargetCostPerSchema;/);
assert.equal((output.match(/export const /g) ?? []).length, 3);

assert.throws(
  () => __test__.postProcessCompatibilityPurchaseCoordinatorInput('export const CompatibilityPurchaseCoordinatorInputSchema = z.any();'),
  /Could not locate the end/
);
assert.throws(
  () => __test__.postProcessCompatibilityPurchaseCoordinatorInput(
    'export const CompatibilityPurchaseCoordinatorInputSchema = z.any();\\nexport const UnexpectedSchema = z.any();\\n\\nexport const OutcomeTargetSchema = z.any();'
  ),
  /would remove other exports/
);
`
  );
  try {
    const result = spawnSync('npx', ['tsx', harness], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
