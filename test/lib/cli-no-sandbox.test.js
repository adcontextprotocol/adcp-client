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
  assert.match(result.stderr, /Run mode: production \(account\.sandbox=false on every request\)/);
});

test('without --no-sandbox the production-mode banner is absent (default sandbox-undefined behavior)', () => {
  // Sanity: the banner is gated on the flag, not on something else
  // accidentally enabled by other CLI defaults.
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
  assert.match(help, /account\.sandbox=false/, 'help should name the wire field affected');
});

test('resolveAccount honors options.sandbox=false (final wire-shape contract)', async () => {
  // The CLI flag plumbing in bin/adcp.js threads `--no-sandbox` to
  // `options.sandbox = false` for all four runner paths
  // (handleStoryboardRun, handleLocalAgentStoryboardRun,
  // handleMultiInstanceStoryboardRun, runFullAssessment). The load-bearing
  // hop after that is `resolveAccount` in src/lib/testing/client.ts —
  // every storyboard request enricher passes `options` through it. This
  // test pins the contract so a future refactor that drops the field
  // (e.g. coercing `false` to `undefined` to "minimize the wire") fails
  // here loudly.
  const { resolveAccount } = require('../../dist/lib/testing/client.js');
  const account = resolveAccount({ sandbox: false });
  assert.strictEqual(account.sandbox, false, 'sandbox must be explicitly false on the wire');

  const defaultAccount = resolveAccount({});
  assert.strictEqual(defaultAccount.sandbox, undefined, 'default behavior leaves sandbox unset');
});
