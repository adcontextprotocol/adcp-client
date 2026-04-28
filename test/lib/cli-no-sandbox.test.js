/**
 * CLI plumbing for `adcp storyboard run --no-sandbox`.
 *
 * Asserts the flag is parsed without value, surfaces in the dry-run header,
 * threads through to options.sandbox = false, and is a no-op when omitted.
 * Uses --dry-run + --url so we never make network calls.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const CLI = path.resolve(__dirname, '../../bin/adcp.js');

function runCli(args) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
}

test('--no-sandbox surfaces "Run mode: production" in multi-instance dry-run header', () => {
  const result = runCli([
    'storyboard',
    'run',
    '--url',
    'https://example.com/a',
    '--url',
    'https://example.com/b',
    '--no-sandbox',
    '--dry-run',
    'capability_discovery',
  ]);
  assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  assert.match(result.stderr, /Run mode: production accounts \(--no-sandbox: account\.sandbox=false\)/);
});

test('without --no-sandbox the production-mode banner is absent (default sandbox-undefined behavior)', () => {
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
  assert.doesNotMatch(result.stderr, /Run mode: production accounts/);
});

test('--no-sandbox is treated as a flag (no value swallowed) — next positional is still the storyboard', () => {
  const result = runCli([
    'storyboard',
    'run',
    '--url',
    'https://example.com/a',
    '--url',
    'https://example.com/b',
    '--no-sandbox',
    '--dry-run',
    'capability_discovery',
  ]);
  assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  // Storyboard parsed correctly — would error with "Unknown storyboard" if --no-sandbox swallowed it
  assert.match(result.stdout, /capability_discovery|Capability Discovery/i);
});

test('storyboard run --help mentions --no-sandbox', () => {
  const result = runCli(['storyboard', 'run', '--help']);
  // Help exits 0 and prints to stderr per the existing convention
  assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  const help = `${result.stdout}\n${result.stderr}`;
  assert.match(help, /--no-sandbox/, 'help text should advertise --no-sandbox');
  assert.match(help, /production code path|account\.sandbox=false/, 'help should explain what the flag does');
});
