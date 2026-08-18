const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const GENERATOR_PATH = path.resolve(__dirname, '../scripts/generate-types.ts');

function runPostprocessor(input) {
  const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-rejected-status-'));
  const scriptPath = path.join(harnessDir, 'harness.ts');
  const outputPath = path.join(harnessDir, 'output.json');
  fs.writeFileSync(
    scriptPath,
    `
import { writeFileSync } from 'node:fs';
import { nameGetProductsRejectedStatus } from ${JSON.stringify(GENERATOR_PATH)};
const input = ${JSON.stringify(input)};
try {
  writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({ output: nameGetProductsRejectedStatus(input, true) }));
} catch (error) {
  writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}
`
  );

  try {
    const result = spawnSync('npx', ['tsx', scriptPath], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, `harness failed:\n${result.stderr}\n${result.stdout}`);
    return JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  } finally {
    fs.rmSync(harnessDir, { recursive: true, force: true });
  }
}

test('get_products rejection status is stable when json-schema-to-typescript renumbers it', () => {
  const input = `
export type TaskStatus7 = 'rejected';
export interface GetProductsRejected {
  status: TaskStatus7;
}
export type OtherStatus8 = 'failed';
`;

  const { output, error } = runPostprocessor(input);

  assert.equal(error, undefined);
  assert.match(output, /export type GetProductsRejectedStatus = 'rejected';/);
  assert.match(output, /export type TaskStatus2 = GetProductsRejectedStatus;/);
  assert.match(output, /status: GetProductsRejectedStatus;/);
  assert.doesNotMatch(output, /TaskStatus7/);
  assert.match(output, /export type OtherStatus8 = 'failed';/);
});

test('get_products rejection status fails closed when the generated shape changes', () => {
  const input = `
export type TaskStatus7 = 'failed';
export interface GetProductsRejected {
  status: TaskStatus7;
}
`;

  const { output, error } = runPostprocessor(input);

  assert.equal(output, undefined);
  assert.match(error, /expected one declaration and two references for TaskStatus7/);
});

test('get_products rejection status fails closed when TaskStatus2 is reassigned', () => {
  const input = `
export type TaskStatus2 = 'failed';
export type TaskStatus7 = 'rejected';
export interface GetProductsRejected {
  status: TaskStatus7;
}
`;

  const { output, error } = runPostprocessor(input);

  assert.equal(output, undefined);
  assert.match(error, /cannot preserve TaskStatus2 because it is already assigned/);
});
