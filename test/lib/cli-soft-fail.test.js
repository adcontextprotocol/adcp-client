// CLI plumbing for `--soft-fail` and `--summary-file` (issue adcp-client#1527).
//
// `parseAgentOptions` is internal to `bin/adcp.js`, so we observe its parsing
// effects through the runner's exit code and side effects rather than calling
// the parser directly. The two contracts under test:
//
//   --soft-fail              ⇒ a failing storyboard exits 0 instead of 3,
//                              and `STORYBOARD FAILURES (...)` may print on
//                              stderr (only when there are named failures —
//                              `unreachable` runs have no per-storyboard
//                              entries, so the block stays silent).
//   --summary-file [PATH]    ⇒ writes the run's Markdown summary to PATH;
//                              defaults to `storyboard-result-summary.md`
//                              when invoked bare.
//   $GITHUB_STEP_SUMMARY=...  ⇒ auto-activates --summary-file with the env
//                              var as the path. No CLI flag required.
//
// We use an unreachable URL to drive a deterministic failing run without
// any network egress (DNS fails before TCP). Exit 3 is the runner's
// failure-without-soft-fail exit code; `--soft-fail` must collapse it to 0.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CLI = path.resolve(__dirname, '../../bin/adcp.js');
// Reserved `.invalid` TLD: never resolves, never reaches the network.
// Suffix the test number so concurrent runs of different tests don't
// collide on cached DNS NXDOMAIN entries.
const UNREACHABLE = 'https://this-host-does-not-exist-1527.example.invalid';
// Storyboard ID is universal — present in every shipped compliance cache.
const STORYBOARD = 'capability_discovery';

function runCli(args, env) {
  return spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    timeout: 45_000,
    env: { ...process.env, ...env },
  });
}

test('failing run without --soft-fail exits 3 (baseline)', () => {
  // Baseline: confirm the runner exits non-zero on an unreachable agent.
  // Without this anchor, the next test's exit-0 assertion proves nothing.
  const res = runCli(['storyboard', 'run', UNREACHABLE, STORYBOARD]);
  assert.strictEqual(res.status, 3, `expected exit 3, got ${res.status}. stderr: ${res.stderr}`);
});

test('failing run with --soft-fail exits 0', () => {
  const res = runCli(['storyboard', 'run', UNREACHABLE, STORYBOARD, '--soft-fail']);
  assert.strictEqual(res.status, 0, `expected exit 0 under --soft-fail, got ${res.status}. stderr: ${res.stderr}`);
});

test('--soft-fail does not affect a passing storyboard ID parse (positional intact)', () => {
  // Regression guard: --soft-fail's flag-parsing must not consume the
  // storyboard positional. If parseAgentOptions's flagValues ever picks up
  // a stray non-null entry, the storyboard ID would be filtered out and
  // the runner would fall back to the all-storyboards path.
  const res = runCli(['storyboard', 'run', UNREACHABLE, STORYBOARD, '--soft-fail']);
  // The "Running storyboard assessment" line lists the requested storyboards.
  // We don't care about pass/fail here, only that the ID survived parsing.
  assert.match(res.stdout, /Storyboards:\s+capability_discovery/);
});

test('--summary-file PATH writes the Markdown summary to PATH', () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'adcp-soft-fail-'));
  try {
    const summary = path.join(tmpDir, 'run.md');
    const res = runCli([
      'storyboard',
      'run',
      UNREACHABLE,
      STORYBOARD,
      '--soft-fail', // collapse the exit code so this test only verifies file writing
      '--summary-file',
      summary,
    ]);
    assert.strictEqual(res.status, 0, `expected exit 0, got ${res.status}. stderr: ${res.stderr}`);
    assert.ok(existsSync(summary), `expected ${summary} to exist after the run`);
    const body = readFileSync(summary, 'utf-8');
    assert.match(body, /^# Storyboard run:/m);
    assert.match(body, /\*\*Overall:\*\*/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('--summary-file without an argument defaults to storyboard-result-summary.md (cwd)', () => {
  // Verify the default-path branch of parseAgentOptions: bare --summary-file
  // (followed by another --flag, so the next token isn't a positional value).
  // The default path is relative to the CLI's cwd, so we run inside a tmpdir
  // and check for the file there.
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'adcp-soft-fail-default-'));
  try {
    const res = spawnSync(
      'node',
      [CLI, 'storyboard', 'run', UNREACHABLE, STORYBOARD, '--summary-file', '--soft-fail'],
      {
        encoding: 'utf8',
        timeout: 45_000,
        cwd: tmpDir,
      }
    );
    assert.strictEqual(res.status, 0, `expected exit 0, got ${res.status}. stderr: ${res.stderr}`);
    const defaultPath = path.join(tmpDir, 'storyboard-result-summary.md');
    assert.ok(existsSync(defaultPath), `expected default summary file at ${defaultPath}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('$GITHUB_STEP_SUMMARY auto-activates --summary-file (env-driven CI integration)', () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'adcp-soft-fail-gha-'));
  try {
    const summary = path.join(tmpDir, 'gha-step-summary.md');
    const res = runCli(['storyboard', 'run', UNREACHABLE, STORYBOARD, '--soft-fail'], {
      GITHUB_STEP_SUMMARY: summary,
    });
    assert.strictEqual(res.status, 0, `expected exit 0, got ${res.status}. stderr: ${res.stderr}`);
    assert.ok(existsSync(summary), `expected ${summary} to exist after env-driven activation`);
    const body = readFileSync(summary, 'utf-8');
    assert.match(body, /^# Storyboard run:/m);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('no --summary-file and no $GITHUB_STEP_SUMMARY ⇒ no file is written', () => {
  // Sanity: the env-auto-activation must not leak from an unrelated env
  // var or from a parser bug that defaults `summaryFile` to a truthy
  // value. We check that no `storyboard-result-summary.md` appears in the
  // working directory after a run with neither flag nor env set.
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'adcp-soft-fail-nofile-'));
  try {
    const res = spawnSync('node', [CLI, 'storyboard', 'run', UNREACHABLE, STORYBOARD, '--soft-fail'], {
      encoding: 'utf8',
      timeout: 45_000,
      cwd: tmpDir,
      // Strip GITHUB_STEP_SUMMARY in case the harness has it set.
      env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
    });
    assert.strictEqual(res.status, 0, `expected exit 0, got ${res.status}. stderr: ${res.stderr}`);
    const defaultPath = path.join(tmpDir, 'storyboard-result-summary.md');
    assert.ok(!existsSync(defaultPath), `did not expect a default summary file at ${defaultPath}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
