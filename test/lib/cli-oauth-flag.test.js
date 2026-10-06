const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

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

for (const field of ['oauth_client', 'oauth_code_verifier', 'oauth_discovery_state']) {
  test(`explicit --clear-oauth clears a ${field}-only record and preserves unrelated configuration`, () => {
    const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-cli-oauth-clear-'));
    try {
      const configDir = path.join(configRoot, '.adcp');
      fs.mkdirSync(configDir);
      const preserved = {
        url: 'https://resource.example/mcp',
        protocol: 'mcp',
        auth_token: 'synthetic-static-bearer',
        oauth_resource: 'https://resource.example/',
        oauth_client_credentials: {
          client_id: 'synthetic-machine-client',
          client_secret: 'synthetic-machine-secret',
          token_endpoint: 'https://identity.example/token',
        },
      };
      const original = {
        agents: {
          fixture: {
            ...preserved,
            [field]:
              field === 'oauth_client'
                ? { client_id: 'unstamped-client' }
                : field === 'oauth_discovery_state'
                  ? { authorizationServerUrl: 'https://identity.example/' }
                  : 'synthetic-verifier',
          },
          unrelated: { url: 'https://other.example/mcp', auth_token: 'other-synthetic-token' },
        },
        defaults: { protocol: 'mcp' },
      };
      const configPath = path.join(configDir, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify(original));
      // Direct the real CLI file manager to this task-owned directory without
      // changing HOME or touching the user's saved configuration.
      const preload = path.join(configRoot, 'config-root.cjs');
      fs.writeFileSync(preload, "require('node:os').homedir = () => process.env.ADCP_TEST_CONFIG_ROOT;\n");
      const result = spawnSync(process.execPath, ['--require', preload, CLI, 'fixture', '--clear-oauth'], {
        encoding: 'utf8',
        timeout: 15000,
        env: { ...process.env, ADCP_TEST_CONFIG_ROOT: configRoot, ADCP_SKIP_VERSION_CHECK: '1' },
      });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
        ...original,
        agents: { ...original.agents, fixture: preserved },
      });
      assert.match(result.stdout, /Cleared OAuth tokens/);
    } finally {
      fs.rmSync(configRoot, { recursive: true, force: true });
    }
  });
}

for (const hintKind of ['provider', 'handler']) {
  test(`${hintKind} reauthorization hint reaches the saved-alias browser flow after explicit clearing`, async () => {
    const { createNonInteractiveOAuthProvider, NonInteractiveFlowHandler } = require('../../dist/lib/auth');
    const { createServer } = require('node:http');
    const { spawn } = require('node:child_process');
    const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-cli-recovery-'));
    let registrationPosts = 0;
    let tokenPosts = 0;
    let origin;
    const server = createServer(async (req, res) => {
      const send = (status, body, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/.well-known/oauth-protected-resource/mcp') {
        return send(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
      }
      if (req.url === '/.well-known/oauth-authorization-server') {
        return send(200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      }
      if (req.url === '/register' && req.method === 'POST') {
        registrationPosts++;
        let body = '';
        for await (const chunk of req) body += chunk;
        return send(201, { ...JSON.parse(body), client_id: 'owned-public-client' });
      }
      if (req.url === '/token') {
        tokenPosts++;
        return send(500, { error: 'unexpected_token_exchange' });
      }
      if (req.url === '/mcp') {
        return send(
          401,
          { error: 'unauthorized' },
          {
            'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          }
        );
      }
      return send(404, { error: 'not_found' });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    try {
      const configDir = path.join(configRoot, '.adcp');
      fs.mkdirSync(configDir);
      const configPath = path.join(configDir, 'config.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          agents: {
            fixture: { url: `${origin}/mcp`, protocol: 'mcp', oauth_client: { client_id: 'old-public-client' } },
          },
        })
      );
      const preload = path.join(configRoot, 'owned-flow.cjs');
      fs.writeFileSync(
        preload,
        [
          "require('node:os').homedir = () => process.env.ADCP_TEST_CONFIG_ROOT;",
          'const { CLIFlowHandler } = require(process.env.ADCP_TEST_AUTH_MODULE);',
          'CLIFlowHandler.prototype.redirectToAuthorization = async function (url) {',
          "  if (url.origin !== process.env.ADCP_TEST_ISSUER) throw new Error('unexpected_authorization_origin');",
          "  throw new Error('owned_interactive_redirect_reached');",
          '};',
        ].join('\n')
      );
      const env = {
        ...process.env,
        ADCP_TEST_CONFIG_ROOT: configRoot,
        ADCP_SKIP_VERSION_CHECK: '1',
        ADCP_TEST_AUTH_MODULE: path.resolve(__dirname, '../../dist/lib/auth'),
        ADCP_TEST_ISSUER: origin,
      };
      const cleared = spawnSync(process.execPath, ['--require', preload, CLI, 'fixture', '--clear-oauth'], {
        encoding: 'utf8',
        timeout: 15000,
        env,
      });
      assert.strictEqual(cleared.status, 0, cleared.stderr);
      assert.strictEqual(JSON.parse(fs.readFileSync(configPath)).agents.fixture.oauth_client, undefined);
      const provider = createNonInteractiveOAuthProvider({
        id: 'fixture',
        agent_uri: `${origin}/mcp`,
        protocol: 'mcp',
      });
      let refusal;
      const attempt =
        hintKind === 'provider'
          ? provider.saveCodeVerifier('unused')
          : new NonInteractiveFlowHandler({ agentHint: 'fixture' }).redirectToAuthorization();
      await assert.rejects(attempt, error => {
        refusal = error;
        return error.code === (hintKind === 'provider' ? 'owner_reauthorization_required' : 'interactive_required');
      });
      const printed =
        hintKind === 'provider'
          ? refusal.message.match(/then (adcp [^.]+)\./)[1]
          : refusal.message.match(/Run `(adcp [^`]+)`/)[1];
      const args = printed
        .replace(/^adcp /, '')
        .replace('<alias>', 'fixture')
        .split(' ');
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--require', preload, CLI, ...args, '--allow-http'], { env });
        let stdout = '',
          stderr = '';
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error('owned recovery CLI timed out'));
        }, 15000);
        child.stdout.on('data', data => {
          stdout += data;
        });
        child.stderr.on('data', data => {
          stderr += data;
        });
        child.once('error', error => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('close', status => {
          clearTimeout(timer);
          resolve({ status, stdout, stderr });
        });
      });
      assert.match(
        result.stderr,
        /owned_interactive_redirect_reached/,
        JSON.stringify({ ...result, registrationPosts, tokenPosts })
      );
      assert.strictEqual(registrationPosts, 1, 'printed recovery reaches the owned authorization server');
      assert.strictEqual(tokenPosts, 0, 'test deliberately stops before browser completion/token exchange');
      assert.strictEqual(JSON.parse(fs.readFileSync(configPath)).agents.fixture.url, `${origin}/mcp`);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(configRoot, { recursive: true, force: true });
    }
  });
}
