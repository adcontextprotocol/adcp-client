/**
 * Tests for the file-backed OAuthConfigStorage.
 *
 * Focuses on the round-trip (save → load round-trip preserves OAuth fields,
 * non-OAuth fields survive overwrites) and the CLI-oriented `agentKey`
 * override that keys writes by alias rather than by `agent.id`.
 */

const { test, describe, before, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createFileOAuthStorage } = require('../../dist/lib/auth/oauth');

let tmpDir;
let configPath;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adcp-oauth-'));
});

beforeEach(async () => {
  configPath = path.join(tmpDir, `config-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
});

describe('createFileOAuthStorage', () => {
  test('returns undefined when the file does not exist', async () => {
    const storage = createFileOAuthStorage({ configPath });
    const loaded = await storage.loadAgent('missing');
    assert.strictEqual(loaded, undefined);
  });

  test('saveAgent creates the file and loadAgent round-trips OAuth fields', async () => {
    const storage = createFileOAuthStorage({ configPath });
    await storage.saveAgent({
      id: 'my-agent',
      name: 'my-agent',
      agent_uri: 'https://agent.example.com/mcp',
      protocol: 'mcp',
      oauth_tokens: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 },
      oauth_client: { client_id: 'cid', redirect_uris: ['http://localhost/cb'] },
    });
    const loaded = await storage.loadAgent('my-agent');
    assert.ok(loaded);
    assert.strictEqual(loaded.agent_uri, 'https://agent.example.com/mcp');
    assert.strictEqual(loaded.oauth_tokens.access_token, 'at');
    assert.strictEqual(loaded.oauth_client.client_id, 'cid');
  });

  test('preserves unrelated fields (e.g. auth_token) across saves', async () => {
    // Pre-seed the file with a saved agent that has a static auth_token.
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: {
          'my-agent': {
            url: 'https://agent.example.com/mcp',
            protocol: 'mcp',
            auth_token: 'static-bearer-should-survive',
          },
        },
      })
    );
    const storage = createFileOAuthStorage({ configPath });
    await storage.saveAgent({
      id: 'my-agent',
      name: 'my-agent',
      agent_uri: 'https://agent.example.com/mcp',
      protocol: 'mcp',
      oauth_tokens: { access_token: 'new-at' },
    });
    const loaded = await storage.loadAgent('my-agent');
    assert.strictEqual(loaded.auth_token, 'static-bearer-should-survive');
    assert.strictEqual(loaded.oauth_tokens.access_token, 'new-at');
  });

  test('agentKey override keys all writes under the fixed alias', async () => {
    const storage = createFileOAuthStorage({ configPath, agentKey: 'real-alias' });
    // The in-memory agent has a synthetic id (CLI pattern: 'cli-agent').
    await storage.saveAgent({
      id: 'cli-agent',
      name: 'CLI Agent',
      agent_uri: 'https://agent.example.com/mcp',
      protocol: 'mcp',
      oauth_tokens: { access_token: 'at' },
    });
    // The storage should have written under 'real-alias', not 'cli-agent'.
    const raw = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    assert.ok(raw.agents['real-alias']);
    assert.strictEqual(raw.agents['cli-agent'], undefined);
    // loadAgent also honors the override.
    const loaded = await storage.loadAgent('cli-agent');
    assert.ok(loaded);
    assert.strictEqual(loaded.oauth_tokens.access_token, 'at');
  });
});
