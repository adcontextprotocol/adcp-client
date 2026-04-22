/**
 * End-to-end CLI tests for `adcp --save-auth` with client credentials.
 *
 * These spawn `node bin/adcp.js …` as a subprocess so we exercise the actual
 * CLI wire — flag parsing, discovery, exchange, persistence. Earlier tests
 * cover the library primitives with stubs; this file covers the glue that
 * can silently break during a refactor (e.g. an inline `require` that falls
 * out of scope, or a branch that forgets to pass `allowPrivateIp`).
 *
 * Isolated by pointing `HOME` at a temp dir so writes to `~/.adcp/config.json`
 * don't touch the user's real config.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const CLI = path.join(__dirname, '..', 'bin', 'adcp.js');

/** Launch the token endpoint + agent-with-well-knowns pair used by each test. */
async function startStack({ oidcOnly = false } = {}) {
  const tokenServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          access_token: 'at_cli_' + Date.now(),
          token_type: 'Bearer',
          expires_in: 3600,
        })
      );
    });
  });
  await new Promise(resolve => tokenServer.listen(0, '127.0.0.1', resolve));
  const tokenUrl = `http://127.0.0.1:${tokenServer.address().port}/token`;

  const agent = http.createServer((req, res) => {
    const base = `http://${req.headers.host}`;
    if (req.url.endsWith('/.well-known/oauth-protected-resource')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ resource: base, authorization_servers: [base] }));
      return;
    }
    // Simulate Keycloak-style AS metadata at the OIDC path only.
    if (oidcOnly && req.url.endsWith('/.well-known/oauth-authorization-server')) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    if (
      req.url.endsWith('/.well-known/oauth-authorization-server') ||
      req.url.endsWith('/.well-known/openid-configuration')
    ) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer: base,
          authorization_endpoint: `${base}/oauth/authorize`,
          token_endpoint: tokenUrl,
          grant_types_supported: ['client_credentials', 'authorization_code'],
        })
      );
      return;
    }
    res.writeHead(401, {
      'content-type': 'application/json',
      'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
    });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  });
  await new Promise(resolve => agent.listen(0, '127.0.0.1', resolve));
  const agentUrl = `http://127.0.0.1:${agent.address().port}/mcp`;

  return {
    tokenUrl,
    agentUrl,
    stop: async () => {
      if (typeof tokenServer.closeAllConnections === 'function') tokenServer.closeAllConnections();
      if (typeof agent.closeAllConnections === 'function') agent.closeAllConnections();
      await Promise.all([
        new Promise(resolve => tokenServer.close(() => resolve())),
        new Promise(resolve => agent.close(() => resolve())),
      ]);
    },
  };
}

/** Run the CLI with a scratch HOME and return { code, stdout, stderr, config }. */
async function runCli(args, { env = {} } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'adcp-cli-test-'));
  const child = spawn('node', [CLI, ...args], {
    env: { ...process.env, HOME: home, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => (stdout += d.toString()));
  child.stderr.on('data', d => (stderr += d.toString()));
  const code = await new Promise(resolve => child.on('close', resolve));
  let config;
  try {
    const raw = await fs.readFile(path.join(home, '.adcp', 'config.json'), 'utf-8');
    config = JSON.parse(raw);
  } catch {
    config = undefined;
  }
  await fs.rm(home, { recursive: true, force: true });
  return { code, stdout, stderr, config };
}

describe('adcp --save-auth (CLI smoke)', () => {
  test('discovers token endpoint and persists CC config (no --oauth-token-url)', async () => {
    const stack = await startStack();
    try {
      const { code, stdout, config } = await runCli([
        '--save-auth',
        'smoke',
        stack.agentUrl,
        '--client-id',
        'CID',
        '--client-secret',
        'SEC',
        '--scope',
        'adcp',
      ]);
      assert.strictEqual(code, 0, `CLI should exit 0, got ${code}`);
      assert.match(stdout, /Discovering OAuth token endpoint/);
      assert.match(stdout, /Found token endpoint:/);
      assert.match(stdout, /Token exchange succeeded/);
      assert.ok(config, 'config.json was written');
      assert.strictEqual(config.agents.smoke.oauth_client_credentials.token_endpoint, stack.tokenUrl);
      assert.strictEqual(config.agents.smoke.oauth_client_credentials.client_id, 'CID');
      assert.strictEqual(config.agents.smoke.oauth_client_credentials.scope, 'adcp');
      assert.ok(config.agents.smoke.oauth_tokens.access_token, 'cached token saved');
    } finally {
      await stack.stop();
    }
  });

  test('--dry-run prints the plan and does not write config or exchange', async () => {
    const stack = await startStack();
    try {
      const { code, stdout, config } = await runCli([
        '--save-auth',
        'smoke',
        stack.agentUrl,
        '--client-id',
        'CID',
        '--client-secret',
        'SEC',
        '--dry-run',
      ]);
      assert.strictEqual(code, 0);
      assert.match(stdout, /Dry run/);
      assert.doesNotMatch(stdout, /Token exchange succeeded/);
      assert.strictEqual(config, undefined, 'config must not be written on --dry-run');
    } finally {
      await stack.stop();
    }
  });

  test('OIDC Discovery fallback: AS metadata only at /.well-known/openid-configuration', async () => {
    const stack = await startStack({ oidcOnly: true });
    try {
      const { code, stdout } = await runCli([
        '--save-auth',
        'smoke',
        stack.agentUrl,
        '--client-id',
        'CID',
        '--client-secret',
        'SEC',
      ]);
      assert.strictEqual(code, 0);
      assert.match(stdout, /OpenID Connect Discovery fallback/);
    } finally {
      await stack.stop();
    }
  });

  test('exits 1 with guidance when the agent advertises no OAuth metadata', async () => {
    // Minimal agent: 401 with no www-authenticate → discovery returns null.
    const agent = http.createServer((req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    await new Promise(resolve => agent.listen(0, '127.0.0.1', resolve));
    const agentUrl = `http://127.0.0.1:${agent.address().port}/mcp`;
    try {
      const { code, stderr } = await runCli([
        '--save-auth',
        'smoke',
        agentUrl,
        '--client-id',
        'CID',
        '--client-secret',
        'SEC',
      ]);
      assert.strictEqual(code, 1);
      assert.match(stderr, /Could not discover an OAuth token endpoint/);
      assert.match(stderr, /adcp diagnose-auth/);
    } finally {
      if (typeof agent.closeAllConnections === 'function') agent.closeAllConnections();
      await new Promise(resolve => agent.close(() => resolve()));
    }
  });

  test('exits 2 when --client-id and --client-id-env are both supplied', async () => {
    const { code, stderr } = await runCli([
      '--save-auth',
      'smoke',
      'https://agent.example.com/mcp',
      '--client-id',
      'CID',
      '--client-id-env',
      'FOO',
      '--client-secret',
      'SEC',
    ]);
    assert.strictEqual(code, 2);
    assert.match(stderr, /Cannot combine --client-id and --client-id-env/);
  });

  test('exits 1 with a distinct message when $ENV:VAR is unset', async () => {
    const stack = await startStack();
    try {
      const { code, stderr } = await runCli(
        ['--save-auth', 'smoke', stack.agentUrl, '--client-id', 'CID', '--client-secret-env', 'ADCP_CLI_TEST_MISSING'],
        { env: { ADCP_CLI_TEST_MISSING: undefined } }
      );
      assert.strictEqual(code, 1);
      assert.match(stderr, /is not set/);
    } finally {
      await stack.stop();
    }
  });
});
