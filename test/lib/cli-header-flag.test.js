/**
 * CLI plumbing for `-H/--header KEY=VALUE` (issue #1563).
 *
 * Asserts:
 *   - `-H` and `--header` are repeatable and survive positional filtering.
 *   - Authorization-class headers are dropped with a stderr warning (auth wins).
 *   - `--save-auth ... -H k=v` persists `headers` in `~/.adcp/config.json`.
 *   - `--list-agents` shows the saved header NAMES (values are tenant-routing
 *     context and treated as sensitive).
 *
 * No live network calls — uses `--dry-run` against a saved alias and a custom
 * HOME pointing at a tmp dir so we don't disturb the developer's real config.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CLI = path.resolve(__dirname, '../../bin/adcp.js');

let tmpHome;

function runCli(args) {
  return spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: tmpHome },
  });
}

function configPath() {
  return path.join(tmpHome, '.adcp', 'config.json');
}

before(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-headers-'));
});

after(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('--save-auth persists -H KEY=VALUE in agent config', () => {
  const result = runCli([
    '--save-auth',
    'tenant-acme',
    'https://agent.example.com/mcp',
    '--auth',
    'tok-abc',
    '-H',
    'x-adcp-tenant=acme',
    '-H',
    'x-correlation-id=run-42',
  ]);
  assert.strictEqual(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);

  const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  assert.deepStrictEqual(cfg.agents['tenant-acme'].headers, {
    'x-adcp-tenant': 'acme',
    'x-correlation-id': 'run-42',
  });
  assert.strictEqual(cfg.agents['tenant-acme'].auth_token, 'tok-abc');
});

test('--save-auth supports the --header KEY=VALUE long form', () => {
  const result = runCli([
    '--save-auth',
    'tenant-long',
    'https://agent.example.com/mcp',
    '--no-auth',
    '--header',
    'x-adcp-tenant=long',
    '--header=x-extra=eq-form',
  ]);
  assert.strictEqual(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);

  const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  assert.deepStrictEqual(cfg.agents['tenant-long'].headers, {
    'x-adcp-tenant': 'long',
    'x-extra': 'eq-form',
  });
});

test('--save-auth drops reserved headers with a stderr warning (auth/signing/transport)', () => {
  const result = runCli([
    '--save-auth',
    'tenant-conflict',
    'https://agent.example.com/mcp',
    '--auth',
    'tok-real',
    '-H',
    'Authorization=Bearer hijack',
    '-H',
    'X-ADCP-Auth=hijack-also',
    '-H',
    'Signature-Input=evil',
    '-H',
    'Content-Type=text/html',
    '-H',
    'x-adcp-tenant=ok',
  ]);
  assert.strictEqual(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);
  assert.match(result.stderr, /ignoring custom Authorization header/);
  assert.match(result.stderr, /ignoring custom X-ADCP-Auth header/);
  assert.match(result.stderr, /ignoring custom Signature-Input header/);
  assert.match(result.stderr, /ignoring custom Content-Type header/);

  const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  assert.deepStrictEqual(cfg.agents['tenant-conflict'].headers, { 'x-adcp-tenant': 'ok' });
  assert.strictEqual(cfg.agents['tenant-conflict'].auth_token, 'tok-real');
});

test('--save-auth rejects -H without KEY=VALUE', () => {
  const result = runCli([
    '--save-auth',
    'tenant-bad',
    'https://agent.example.com/mcp',
    '--no-auth',
    '-H',
    'no-equals-here',
  ]);
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /-H requires KEY=VALUE/);
});

test('-H rejects values containing CR, LF, or NUL (header smuggling defense)', () => {
  const result = runCli([
    '--save-auth',
    'tenant-crlf',
    'https://agent.example.com/mcp',
    '--no-auth',
    '-H',
    'X-Smuggle=ok\r\nAuthorization: Bearer evil',
  ]);
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /CR, LF, or NUL/);
  // Config must NOT have been written with the malicious value.
  const cfg = fs.existsSync(configPath()) ? JSON.parse(fs.readFileSync(configPath(), 'utf8')) : { agents: {} };
  assert.strictEqual(cfg.agents['tenant-crlf'], undefined);
});

test('-H rejects keys outside the RFC 7230 token charset', () => {
  const result = runCli([
    '--save-auth',
    'tenant-bad-key',
    'https://agent.example.com/mcp',
    '--no-auth',
    '-H',
    'Foo: bar=value',
  ]);
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /token charset/);
});

test('saved headers loaded from disk are filtered against the reserved set', () => {
  // Hand-edit the saved config to include a smuggled `authorization` (lowercase)
  // header. The merge step must drop it on read so it can't shadow the SDK's
  // `Authorization` header during a real request.
  const cfgFile = configPath();
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.agents['tenant-handedited'] = {
    url: 'https://agent.example.com/mcp',
    protocol: 'mcp',
    auth_token: 'tok-real',
    headers: {
      authorization: 'Bearer attacker',
      'x-adcp-tenant': 'real-tenant',
    },
  };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });

  const result = runCli(['tenant-handedited', '--debug']);
  // Use --debug so mergeHeaders' warning surfaces. The alias resolves and the
  // network call fails, but the header filter runs before any network IO.
  assert.match(result.stderr, /ignoring saved authorization header/);
});

test('--list-agents shows saved header names but not values', () => {
  // Reuse 'tenant-acme' saved by the first test in this file. Test order is
  // explicit (node:test runs in declared order), so this is deterministic.
  const result = runCli(['--list-agents']);
  assert.strictEqual(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);
  assert.match(result.stdout, /tenant-acme/);
  assert.match(result.stdout, /Headers: x-adcp-tenant, x-correlation-id/);
  // Values must NOT leak — they may carry tenant-routing tokens.
  assert.doesNotMatch(result.stdout, /run-42/);
});

test('-H short form interleaved with positionals does not eat the JSON payload', () => {
  // The exact shape from the issue: a saved alias, a tool name, an inline JSON
  // payload, and one or more `-H` flags. Verifies parseHeaderFlags' consumed-
  // tokens set excludes only the flag and its KEY=VALUE — not the JSON.
  // We use --debug to surface the parsed payload without making a network call.
  const result = runCli([
    'tenant-acme',
    'get_products',
    '{"brief":"coffee brands"}',
    '-H',
    'x-adcp-tenant=runtime-override',
    '--debug',
  ]);
  // The parser must reach the "Configuration" debug block — proves the JSON
  // wasn't mis-classified as a flag value.
  assert.match(result.stderr, /Tool: get_products/);
  assert.match(result.stderr, /Payload:[\s\S]*"brief"/);
});
