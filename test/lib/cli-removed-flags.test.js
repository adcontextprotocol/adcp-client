const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const CLI = path.resolve(__dirname, '../../bin/adcp.js');

// Every spawn gets a timeout so a regression that accidentally reaches a live
// agent path (runFullAssessment doesn't honor --dry-run) fails fast instead of
// hanging CI.
function runCli(args) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8', timeout: 10_000 });
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
  const result = runCli([
    'storyboard',
    'run',
    'test-mcp',
    '--platform-type',
    'creative_transformer',
    '--strict-flags',
  ]);
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
