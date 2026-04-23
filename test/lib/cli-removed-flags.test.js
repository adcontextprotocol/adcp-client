const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const CLI = path.resolve(__dirname, '../../bin/adcp.js');

function runCli(args) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
}

test('--platform-type emits a deprecation warning on stderr under storyboard run', () => {
  const result = runCli([
    'storyboard',
    'run',
    'test-mcp',
    '--platform-type',
    'creative_transformer',
    '--dry-run',
    'capability_discovery',
  ]);
  assert.match(
    result.stderr,
    /\[warn\] --platform-type was removed in 5\.1\.0/,
    `expected removed-flag warning on stderr, got: ${result.stderr}`
  );
  assert.match(result.stderr, /get_adcp_capabilities/);
});

test('--platform-type warning is suppressed under --json so stdout stays pure JSON', () => {
  const result = runCli([
    'storyboard',
    'run',
    'test-mcp',
    '--platform-type',
    'creative_transformer',
    '--dry-run',
    '--json',
    'capability_discovery',
  ]);
  assert.doesNotMatch(result.stderr, /\[warn\] --platform-type/);
});

test('--platform-type=value form is also detected', () => {
  const result = runCli([
    'storyboard',
    'run',
    'test-mcp',
    '--platform-type=creative_transformer',
    '--dry-run',
    'capability_discovery',
  ]);
  assert.match(result.stderr, /\[warn\] --platform-type was removed/);
});

test('adcp comply (deprecated alias) still surfaces removed-flag warnings', () => {
  const result = runCli([
    'comply',
    'test-mcp',
    '--platform-type',
    'creative_transformer',
    '--dry-run',
    'capability_discovery',
  ]);
  assert.match(result.stderr, /\[warn\] --platform-type was removed/);
});

test('no warning when --platform-type is absent', () => {
  const result = runCli(['storyboard', 'run', 'test-mcp', '--dry-run', 'capability_discovery']);
  assert.doesNotMatch(result.stderr, /removed in 5\.1\.0/);
});
