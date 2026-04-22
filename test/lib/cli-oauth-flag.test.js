const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const CLI = path.resolve(__dirname, '../../bin/adcp.js');

function runCli(args) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
}

test('storyboard run --oauth with a raw URL prints a save-first warning and proceeds (human mode)', () => {
  const result = runCli([
    'storyboard',
    'run',
    'https://example.test/mcp',
    '--oauth',
    '--dry-run',
    '--storyboards',
    'security_baseline',
  ]);
  assert.match(result.stderr, /--oauth requires a saved agent alias/, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /Save first: adcp --save-auth <alias> https:\/\/example\.test\/mcp --oauth/);
});

test('storyboard run --oauth --json with a raw URL emits structured error and exits 2', () => {
  const result = runCli(['storyboard', 'run', 'https://example.test/mcp', '--oauth', '--json', '--dry-run']);
  assert.strictEqual(result.status, 2, `expected exit 2, got ${result.status}. stderr: ${result.stderr}`);
  const lines = result.stdout.trim().split('\n');
  // The structured error is on stdout; the last parsable JSON line is what
  // CI jobs look at. Find it rather than asserting it's the first line, so
  // unrelated stdout noise (sync-version banner etc.) doesn't brittle-fail.
  const payload = lines
    .reverse()
    .map(l => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .find(p => p && p.error === 'oauth_requires_alias');
  assert.ok(payload, `expected oauth_requires_alias payload, got stdout=\n${result.stdout}`);
  assert.strictEqual(payload.success, false);
  assert.match(payload.message, /Save first:/);
});
