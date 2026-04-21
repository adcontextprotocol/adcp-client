const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const CLI = path.resolve(__dirname, '../../bin/adcp.js');

function runCli(args) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
}

test('--multi-instance-strategy multi-pass dry-run shows per-pass plan', () => {
  const result = runCli([
    'storyboard',
    'run',
    '--url',
    'https://example.com/a',
    '--url',
    'https://example.com/b',
    '--multi-instance-strategy',
    'multi-pass',
    '--dry-run',
    'capability_discovery',
  ]);
  assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  assert.match(result.stderr, /multi-pass \(2 passes\)/);
  assert.match(result.stdout, /Pass 1 of 2 \(starts at \[#1\]\)/);
  assert.match(result.stdout, /Pass 2 of 2 \(starts at \[#2\]\)/);
  // N=2 caveat banner
  assert.match(result.stderr, /does NOT cover cross-replica write→read pairs at\s*\n\s*even dispatch-index distance/);
});

test('--multi-instance-strategy round-robin dry-run shows single plan', () => {
  const result = runCli([
    'storyboard',
    'run',
    '--url',
    'https://example.com/a',
    '--url',
    'https://example.com/b',
    '--multi-instance-strategy',
    'round-robin',
    '--dry-run',
    'capability_discovery',
  ]);
  assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  assert.match(result.stderr, /round-robin \(1 pass\)/);
  assert.doesNotMatch(result.stdout, /Pass 1 of/);
  // No N=2 caveat banner for round-robin
  assert.doesNotMatch(result.stderr, /does NOT cover cross-replica/);
});

test('--multi-instance-strategy with bogus value is rejected', () => {
  const result = runCli([
    'storyboard',
    'run',
    '--url',
    'https://example.com/a',
    '--url',
    'https://example.com/b',
    '--multi-instance-strategy',
    'bogus',
    '--dry-run',
    'capability_discovery',
  ]);
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /must be "round-robin" or "multi-pass", got "bogus"/);
});

test('--multi-instance-strategy without a value is rejected', () => {
  const result = runCli([
    'storyboard',
    'run',
    '--url',
    'https://example.com/a',
    '--url',
    'https://example.com/b',
    '--multi-instance-strategy',
    '--dry-run',
    'capability_discovery',
  ]);
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /--multi-instance-strategy requires a value/);
});

test('--multi-instance-strategy default is round-robin', () => {
  const result = runCli([
    'storyboard',
    'run',
    '--url',
    'https://example.com/a',
    '--url',
    'https://example.com/b',
    '--dry-run',
    'capability_discovery',
  ]);
  assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  assert.match(result.stderr, /round-robin \(1 pass\)/);
});
