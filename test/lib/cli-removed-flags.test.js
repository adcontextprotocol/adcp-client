const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const CLI = path.resolve(__dirname, '../../bin/adcp.js');

// Every spawn gets a timeout so a regression that accidentally reaches a live
// agent path (runFullAssessment doesn't honor --dry-run) fails fast instead of
// hanging CI.
function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
}

// Call the command with no agent arg so `handleStoryboardRun` exits at the
// "Usage:" check (exit 2). `warnRemovedFlags` fires at the top of the handler,
// before that check — so we get the warning without any network call.

test('--platform-type emits a deprecation warning on stderr under storyboard run', () => {
  const result = runCli(['storyboard', 'run', '--platform-type', 'creative_transformer']);
  assert.strictEqual(result.status, 2, `expected exit 2 (usage), got ${result.status}. stderr: ${result.stderr}`);
  assert.match(
    result.stderr,
    /DEPRECATED: --platform-type was removed in 5\.1\.0/,
    `expected removed-flag warning on stderr, got: ${result.stderr}`
  );
  assert.match(result.stderr, /get_adcp_capabilities/);
});

test('--platform-type warning still reaches stderr under --json (stdout stays pure JSON)', () => {
  const result = runCli(['storyboard', 'run', '--platform-type', 'creative_transformer', '--json']);
  // Warning must reach stderr so CI log streams capture it. stderr never
  // pollutes stdout JSON, so --json is not a reason to suppress.
  assert.match(result.stderr, /DEPRECATED: --platform-type was removed/);
});

test('--platform-type=value form is also detected', () => {
  const result = runCli(['storyboard', 'run', '--platform-type=creative_transformer']);
  assert.match(result.stderr, /DEPRECATED: --platform-type was removed/);
});

test('adcp comply (deprecated alias) still surfaces removed-flag warnings', () => {
  const result = runCli(['comply', '--platform-type', 'creative_transformer']);
  assert.match(result.stderr, /DEPRECATED: --platform-type was removed/);
});

test('no warning when --platform-type is absent', () => {
  const result = runCli(['storyboard', 'run']);
  assert.doesNotMatch(result.stderr, /removed in 5\.1\.0/);
});

test('warning is advisory — exit status reflects the real command outcome, not the warning', () => {
  // No agent arg → exit 2 (usage). Adding --platform-type must not change that.
  const withFlag = runCli(['storyboard', 'run', '--platform-type', 'creative_transformer']);
  const withoutFlag = runCli(['storyboard', 'run']);
  assert.strictEqual(
    withFlag.status,
    withoutFlag.status,
    'removed-flag warning must not alter exit status — it is advisory'
  );
});

test('--strict-flags upgrades the warning to a hard exit 2', () => {
  // Passing a removed flag + --strict-flags must exit 2 with a pointed message,
  // so CI pipelines can catch stale scripts as build-breakers.
  const result = runCli(['storyboard', 'run', 'test-mcp', '--platform-type', 'creative_transformer', '--strict-flags']);
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /DEPRECATED: --platform-type was removed/);
  assert.match(result.stderr, /ERROR: --strict-flags was set/);
  assert.match(result.stderr, /--platform-type/);
});

test('--strict-flags alone (no removed flags) is a no-op', () => {
  // Passing --strict-flags without any removed flag must not cause a failure
  // beyond whatever the underlying command would do. No agent → exit 2 (usage),
  // which is the same as without --strict-flags.
  const withStrict = runCli(['storyboard', 'run', '--strict-flags']);
  const withoutStrict = runCli(['storyboard', 'run']);
  assert.strictEqual(withStrict.status, withoutStrict.status);
  assert.doesNotMatch(withStrict.stderr, /--strict-flags was set/);
});

test('storyboard step also warns + honors --strict-flags', () => {
  // The strict-flags machinery is shared across runner commands. storyboard
  // step would otherwise silently accept `--platform-type` — verify it
  // warns advisorily by default and hard-exits under --strict-flags.
  const advisory = runCli(['storyboard', 'step', '--platform-type', 'x']);
  assert.match(advisory.stderr, /DEPRECATED: --platform-type was removed/);

  const strict = runCli(['storyboard', 'step', '--platform-type', 'x', '--strict-flags']);
  assert.strictEqual(strict.status, 2);
  assert.match(strict.stderr, /ERROR: --strict-flags was set/);
});

test('storyboard step compatibility flags use parsed options without an undefined opts reference', () => {
  const source = fs.readFileSync(CLI, 'utf8');
  const handler = source.slice(
    source.indexOf('async function handleStoryboardStepCmd'),
    source.indexOf('\nasync function ', source.indexOf('async function handleStoryboardStepCmd') + 1)
  );
  assert.match(handler, /mediaBuyLifecycleCompatibility/);
  assert.match(source, /principalScope: mediaBuyPrincipalScopeValue/);
  assert.doesNotMatch(handler, /opts\.mediaBuyLifecycleCompatibility/);
});

test('--media-buy-principal-scope requires a non-empty value', () => {
  for (const args of [
    ['storyboard', 'run', '--media-buy-principal-scope'],
    ['storyboard', 'run', '--media-buy-principal-scope='],
  ]) {
    const result = runCli(args);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /--media-buy-principal-scope requires a non-empty value/);
  }
});

test('--media-buy-principal-scope value is not mistaken for the agent argument', () => {
  const result = runCli([
    'storyboard',
    'run',
    '--media-buy-lifecycle-compat',
    '--media-buy-principal-scope',
    'buyer-tenant-1',
  ]);
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /Usage: adcp storyboard run/);
  assert.doesNotMatch(result.stderr, /requires a non-empty value/);
});

test('--media-buy-compat-losses requires lifecycle compatibility to be enabled', () => {
  for (const args of [
    ['storyboard', 'run', '--media-buy-compat-losses', 'feed_version_not_atomic'],
    ['storyboard', 'run', '--media-buy-compat-losses=feed_version_not_atomic'],
  ]) {
    const result = runCli(args);
    assert.strictEqual(result.status, 2);
    assert.match(
      result.stderr,
      /--media-buy-compat-losses requires --media-buy-lifecycle-compat or --force-established-media-buy-lifecycle/
    );
  }
});

test('--media-buy-compat-losses is accepted with either lifecycle compatibility mode', () => {
  for (const compatibilityFlag of ['--media-buy-lifecycle-compat', '--force-established-media-buy-lifecycle']) {
    const result = runCli([
      'storyboard',
      'run',
      compatibilityFlag,
      '--media-buy-compat-losses',
      'feed_version_not_atomic',
    ]);
    assert.strictEqual(result.status, 2, `expected the missing-agent usage exit for ${compatibilityFlag}`);
    assert.match(result.stderr, /Usage: adcp storyboard run/);
    assert.doesNotMatch(result.stderr, /--media-buy-compat-losses requires/);
  }
});
