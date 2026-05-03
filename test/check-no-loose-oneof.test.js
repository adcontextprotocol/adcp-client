// Regression test for #1380's codegen strictness guard.
// Confirms `scripts/check-no-loose-oneof.ts` catches the bug pattern
// (a union arm shaped exactly `{ [k: string]: unknown | undefined }`)
// while leaving allowed shapes alone (top-level freeform-blob aliases,
// nested property types, intersection arms).

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const CHECK_SCRIPT = path.resolve(REPO_ROOT, 'scripts/check-no-loose-oneof.ts');

/**
 * Runs the production check script against a one-off fixture file via
 * the `ADCP_LOOSE_ONEOF_FILES` test hook. Returns
 * `{ exitCode, stdout, stderr }`.
 */
function runCheckOnFixture(fixtureContent) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loose-oneof-'));
  const fixturePath = path.join(tmpDir, '__fixture__.generated.ts');
  fs.writeFileSync(fixturePath, fixtureContent);
  try {
    const r = spawnSync('npx', ['tsx', CHECK_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, ADCP_LOOSE_ONEOF_FILES: fixturePath },
    });
    return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('check-no-loose-oneof — bug-pattern recognition', () => {
  it('flags a union arm that is exactly `{ [k: string]: unknown | undefined }`', () => {
    const r = runCheckOnFixture(`export type LooseUnion = { typed: string } | { [k: string]: unknown | undefined };`);
    assert.strictEqual(r.exitCode, 1, `expected exit 1, got ${r.exitCode}; stderr: ${r.stderr}`);
    assert.match(r.stderr, /LooseUnion/);
    assert.match(r.stderr, /\[variant 1\]/);
  });

  it('does NOT flag a top-level freeform-blob alias (e.g. ForecastRange)', () => {
    const r = runCheckOnFixture(`export type ForecastRange = { [k: string]: unknown | undefined };`);
    assert.strictEqual(r.exitCode, 0, `expected exit 0, got ${r.exitCode}; stderr: ${r.stderr}`);
  });

  it('does NOT flag a nested property of bare-blob type', () => {
    const r = runCheckOnFixture(`export interface HasFreeForm { freeform: { [k: string]: unknown | undefined } }`);
    assert.strictEqual(r.exitCode, 0);
  });

  it('does NOT flag a typed index signature (e.g. `{ [k: string]: ForecastRange | undefined }`)', () => {
    const r = runCheckOnFixture(`export type Typed = { typed: string } | { [k: string]: ForecastRange | undefined };`);
    assert.strictEqual(r.exitCode, 0);
  });

  it('flags an interface property whose union arm is the bare blob', () => {
    const r = runCheckOnFixture(
      `export interface HasLooseUnion { field: { typed: string } | { [k: string]: unknown | undefined } }`
    );
    assert.strictEqual(r.exitCode, 1);
    assert.match(r.stderr, /HasLooseUnion\.field/);
  });
});

describe('check-no-loose-oneof — production scanner', () => {
  it('passes against current generated types (regression baseline)', () => {
    const r = spawnSync('npx', ['tsx', CHECK_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0, `production scanner failed: ${r.stderr}`);
    assert.match(r.stdout, /No loose oneOf arms detected/);
  });
});
