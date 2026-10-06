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
