/**
 * CLI plumbing for `--auth-scheme bearer|basic` (HTTP Basic auth for gateways
 * fronting an AdCP agent — Apigee, Kong, AWS API GW with a BasicAuthentication
 * policy that rejects `Authorization: Bearer` outright).
 *
 * Asserts:
 *   - `--save-auth … --auth user:pass --auth-scheme basic` persists
 *     `auth_scheme: 'basic'` alongside the raw `user:pass` in
 *     `~/.adcp/config.json`. The scheme survives a round trip through the
 *     saved-agent path.
 *   - `--auth-scheme basic` requires `--auth` (no token = nothing to encode).
 *   - `--auth-scheme basic --auth <token-without-colon>` fails at register time
 *     so a typo doesn't surface as a confusing decode error on every later call.
 *   - `--auth-scheme bogus` is rejected at parse time.
 *   - `--list-agents` surfaces the scheme so operators can tell at a glance.
 *   - Wire test: a saved basic alias produces `Authorization: Basic <b64>` on
 *     the actual transport — no `Bearer` token leaks through.
 *
 * Isolated by pointing `HOME` at a temp dir so writes to `~/.adcp/config.json`
 * don't touch the user's real config.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CLI = path.resolve(__dirname, '../../bin/adcp.js');

let tmpHome;

function runCli(args, extraEnv = {}, opts = {}) {
  return spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: tmpHome, ...extraEnv },
    timeout: opts.timeout ?? 10000,
  });
}

function configPath() {
  return path.join(tmpHome, '.adcp', 'config.json');
}

before(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-authscheme-'));
});

after(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('--save-auth persists auth_scheme=basic with user:pass credentials', () => {
  const result = runCli([
    '--save-auth',
    'gateway-basic',
    'https://agent.example.com/mcp',
    '--auth',
    'svc-user:s3cret-pa55',
    '--auth-scheme',
    'basic',
  ]);
  assert.strictEqual(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);
  const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  assert.strictEqual(cfg.agents['gateway-basic'].auth_token, 'svc-user:s3cret-pa55');
  assert.strictEqual(cfg.agents['gateway-basic'].auth_scheme, 'basic');
});

test('--save-auth omits auth_scheme when scheme is bearer (default)', () => {
  const result = runCli(['--save-auth', 'gateway-bearer', 'https://agent.example.com/mcp', '--auth', 'tok-abc']);
  assert.strictEqual(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);
  const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  assert.strictEqual(cfg.agents['gateway-bearer'].auth_token, 'tok-abc');
  assert.strictEqual(
    cfg.agents['gateway-bearer'].auth_scheme,
    undefined,
    'bearer is the default; the field is omitted to keep config files clean'
  );
});

test('--auth-scheme rejects values other than bearer|basic', () => {
  const result = runCli([
    '--save-auth',
    'bad-scheme',
    'https://agent.example.com/mcp',
    '--auth',
    'whatever',
    '--auth-scheme',
    'digest',
  ]);
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /--auth-scheme must be 'bearer' or 'basic'/);
});

test('--auth-scheme basic requires --auth (no token = nothing to encode)', () => {
  const result = runCli(['--save-auth', 'no-token', 'https://agent.example.com/mcp', '--auth-scheme', 'basic']);
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /--auth-scheme requires --auth/);
});

test('--auth-scheme basic rejects an --auth value missing the colon at register time', () => {
  const result = runCli([
    '--save-auth',
    'malformed',
    'https://agent.example.com/mcp',
    '--auth',
    'no-colon-here',
    '--auth-scheme',
    'basic',
  ]);
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /must contain ':'/);
  // Config must not have been written.
  const cfg = fs.existsSync(configPath()) ? JSON.parse(fs.readFileSync(configPath(), 'utf8')) : { agents: {} };
  assert.strictEqual(cfg.agents['malformed'], undefined);
});

test('--auth-scheme basic rejects empty username', () => {
  const result = runCli([
    '--save-auth',
    'empty-user',
    'https://agent.example.com/mcp',
    '--auth',
    ':only-password',
    '--auth-scheme',
    'basic',
  ]);
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /username must not be empty/);
});

test('--auth-scheme basic rejects CR/LF in the credential (header-smuggling defense)', () => {
  const result = runCli([
    '--save-auth',
    'crlf',
    'https://agent.example.com/mcp',
    '--auth',
    'user:pass\r\nX-Smuggle: yes',
    '--auth-scheme',
    'basic',
  ]);
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /CR, LF, NUL, or non-printable/);
});

test('--list-agents shows the auth scheme for basic-auth aliases', () => {
  // Reuses 'gateway-basic' from the first test. node:test runs in declared order.
  const result = runCli(['--list-agents']);
  assert.strictEqual(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);
  assert.match(result.stdout, /gateway-basic/);
  assert.match(result.stdout, /Auth: token configured \(basic \(user:pass\)\)/);
  // Bearer alias must still show without surprising the user.
  assert.match(result.stdout, /gateway-bearer/);
  assert.match(result.stdout, /Auth: token configured \(bearer\)/);
});

test('wire test: basic alias sends Authorization: Basic <b64(user:pass)>, not Bearer', async t => {
  // Spin up a tiny MCP-ish server that captures every Authorization header
  // it sees and returns 401 so the CLI exits quickly. The /mcp probe and the
  // RFC 9728 well-known probes both flow through here; we want the Authorization
  // header attached to the /mcp probe (the only path that actually carries
  // user-supplied auth — well-knowns are unauthenticated by spec).
  const seenAuthByPath = {};
  const server = http.createServer((req, res) => {
    seenAuthByPath[req.url] = req.headers.authorization ?? '';
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/mcp`;

  t.after(async () => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise(resolve => server.close(() => resolve()));
  });

  // Save the alias pointing at the local server, then invoke it.
  const save = runCli([
    '--save-auth',
    'wire-basic',
    url,
    'mcp',
    '--auth',
    'inmobi:gateway-secret',
    '--auth-scheme',
    'basic',
  ]);
  assert.strictEqual(save.status, 0, `save failed, stderr: ${save.stderr}`);

  // `adcp <alias> <tool>` resolves the alias and dispatches via MCP. The SDK
  // walks /mcp + /mcp/ + a couple of well-known probes when discovering an
  // unknown endpoint; we let that play out (up to ~15s) and then assert on
  // the first /mcp probe's Authorization header — the only header the SDK
  // attaches user-supplied auth to.
  //
  // CRITICAL: must use async `spawn`, not `spawnSync`. The local HTTP server
  // runs on the same Node event loop as the test runner; `spawnSync` blocks
  // the loop until the child exits, so the server never accepts the child's
  // requests and the test deadlocks until the timeout.
  const run = await new Promise(resolve => {
    const child = spawn('node', [CLI, 'wire-basic', 'get_products', '{"brief":"x"}', '--allow-http', '--debug'], {
      env: { ...process.env, HOME: tmpHome },
    });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', d => (stderr += d.toString()));
    child.stdout.on('data', d => (stdout += d.toString()));
    const killer = setTimeout(() => child.kill('SIGTERM'), 15000);
    child.on('exit', code => {
      clearTimeout(killer);
      resolve({ status: code, stderr, stdout });
    });
  });

  const paths = Object.keys(seenAuthByPath);
  assert.ok(
    paths.length > 0,
    `expected the local server to receive at least one request — stderr was:\n${run.stderr}\nstdout was:\n${run.stdout}`
  );

  // The SDK walks /mcp + /mcp/ + a couple of well-knowns when discovering an
  // unknown MCP endpoint. We assert two things:
  //   1. At least one /mcp[/] probe carried the Basic header — proves the
  //      scheme switch actually reached the wire.
  //   2. No /mcp[/] probe ever sent `Authorization: Bearer …` — proves the
  //      CLI didn't leak the credential in the wrong scheme.
  // Well-known probes are unauthenticated by spec and intentionally excluded.
  const expected = 'Basic ' + Buffer.from('inmobi:gateway-secret').toString('base64');
  const mcpProbeAuths = Object.entries(seenAuthByPath)
    .filter(([p]) => !p.includes('/.well-known/'))
    .map(([, a]) => a);
  assert.ok(
    mcpProbeAuths.some(a => a === expected),
    `expected at least one /mcp probe to carry '${expected}'.\n` +
      `Headers by path: ${JSON.stringify(seenAuthByPath, null, 2)}\n` +
      `stderr was:\n${run.stderr}`
  );
  for (const auth of mcpProbeAuths) {
    assert.doesNotMatch(
      auth ?? '',
      /^Bearer /,
      `bearer prefix on an /mcp probe means --auth-scheme basic was ignored.\n` +
        `Headers by path: ${JSON.stringify(seenAuthByPath, null, 2)}`
    );
  }
});
