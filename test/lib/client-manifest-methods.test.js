const { describe, test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const { AgentClient, SingleAgentClient, ProtocolClient, ADCP_VERSION } = require('../../dist/lib/index.js');

const bundleKey = ADCP_VERSION.includes('-') ? ADCP_VERSION : ADCP_VERSION.split('.').slice(0, 2).join('.');
const manifest = JSON.parse(fs.readFileSync(path.resolve('dist/lib/schemas-data', bundleKey, 'manifest.json')));
const camel = name => name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
const agent = { id: 'typed-seller', name: 'Typed seller', protocol: 'mcp', agent_uri: 'https://seller.example/mcp' };

function clientFor(Client, responses = 'off') {
  const client = new Client(agent, {
    adcpVersion: '3.2.7',
    validateFeatures: false,
    validation: { requests: 'strict', responses },
  });
  const single = client instanceof AgentClient ? client.client : client;
  mock.method(single, 'getCapabilities', async () => ({
    version: 'v3',
    majorVersions: [3],
    supportedVersions: ['3.2.7'],
    protocols: ['media_buy', 'governance', 'creative', 'brand'],
    features: {},
    extensions: [],
    discoveredTools: Object.keys(manifest.tools),
    _synthetic: false,
  }));
  mock.method(single, 'ensureEndpointDiscovered', async () => agent);
  return client;
}

describe('typed client manifest coverage (#3447)', () => {
  afterEach(() => mock.restoreAll());

  for (const Client of [AgentClient, SingleAgentClient]) {
    test(`${Client.name} has a non-deprecated typed method for every manifest tool`, () => {
      const declarations = ts.createSourceFile(
        'client.d.ts',
        fs.readFileSync(path.resolve('dist/lib/core', `${Client.name}.d.ts`), 'utf8'),
        ts.ScriptTarget.Latest
      );
      const methods = declarations.statements.find(
        node => ts.isClassDeclaration(node) && node.name.text === Client.name
      ).members;
      for (const tool of Object.keys(manifest.tools)) {
        const name = camel(tool);
        assert.equal(typeof Client.prototype[name], 'function', `${Client.name}.${name} missing for ${tool}`);
        const signatures = methods.filter(node => node.name?.getText(declarations) === name);
        assert.ok(signatures.length, `${Client.name}.${name} missing from declarations`);
        assert.ok(
          signatures.some(node => !ts.getJSDocTags(node).some(tag => tag.tagName.text === 'deprecated')),
          `${Client.name}.${name} only has deprecated signatures`
        );
      }
    });

    test(`${Client.name}: typed calls negotiate the pin and generate or preserve mutation keys`, async () => {
      const client = clientFor(Client);
      const calls = mock.method(ProtocolClient, 'callTool', async (_agent, tool, params, options) => {
        assert.equal(tool, 'sync_catalogs');
        assert.equal(options.wireAdcpVersion, '3.2.7');
        return { structuredContent: { catalogs: [] }, content: [] };
      });
      const params = { account: { account_id: 'account-1' } };
      await client.syncCatalogs(params);
      assert.match(calls.mock.calls[0].arguments[2].idempotency_key, /^[A-Za-z0-9_.:-]{16,255}$/);
      assert.equal(params.idempotency_key, undefined, 'caller-owned input is not mutated');
      await client.syncCatalogs({ ...params, idempotency_key: 'caller-owned-key-12345' });
      assert.equal(calls.mock.calls[1].arguments[2].idempotency_key, 'caller-owned-key-12345');
    });

    test(`${Client.name}: malformed typed requests fail before dispatch`, async () => {
      const client = clientFor(Client);
      const calls = mock.method(ProtocolClient, 'callTool', async () => assert.fail('invalid input was dispatched'));
      const result = await client.searchBrands({});
      assert.equal(result.success, false);
      assert.match(result.error, /query|[Vv]alidation/);
      assert.equal(calls.mock.callCount(), 0);
    });

    test(`${Client.name}: existing custom-task workarounds remain usable`, async () => {
      const client = clientFor(Client);
      mock.method(ProtocolClient, 'callTool', async () => ({ structuredContent: { catalogs: [] }, content: [] }));
      const result = await client.executeCustomTask('sync_catalogs', { account: { account_id: 'account-1' } });
      assert.equal(result.success, true, result.error);
    });

    for (const state of [
      'working',
      'submitted',
      'input-required',
      'auth-required',
      'completed',
      'failed',
      'rejected',
      'canceled',
    ]) {
      test(`${Client.name}: typed status queries return ${state} as data without following the observed task`, async () => {
        const client = clientFor(Client, 'strict');
        const data = {
          task_id: 'work-1',
          task_type: 'sync_catalogs',
          protocol: 'media-buy',
          status: state,
          created_at: '2026-10-01T00:00:00Z',
          updated_at: '2026-10-01T00:00:00Z',
          ...(['failed', 'rejected'].includes(state) && { error: { code: 'FAILED', message: 'Observed task failed' } }),
          ...(state === 'completed' && { result: { catalogs: [] } }),
        };
        const calls = mock.method(ProtocolClient, 'callTool', async (_agent, tool) => {
          assert.equal(tool, 'get_task_status');
          return { structuredContent: data, content: [] };
        });
        const result = await client.getTaskStatus({ task_id: 'work-1', include_result: true });
        assert.equal(result.success, true, result.error);
        assert.equal(result.status, 'completed');
        assert.deepEqual(result.data, data);
        assert.equal(calls.mock.callCount(), 1);
      });
    }

    test(`${Client.name}: no-argument listTasks retains the local API; an object queries the seller`, async () => {
      const client = clientFor(Client);
      const calls = mock.method(ProtocolClient, 'callTool', async (_agent, tool) => {
        assert.equal(tool, 'list_tasks');
        return { structuredContent: { query_summary: {}, tasks: [], pagination: { has_more: false } }, content: [] };
      });
      assert.deepEqual(await client.listTasks(), []);
      assert.equal(calls.mock.callCount(), 0);
      assert.equal((await client.listTasks({})).success, true);
      assert.equal(calls.mock.callCount(), 1);
    });
  }

  test('manifest methods and executeTask maps retain typed inputs and outputs', () => {
    execFileSync(
      process.execPath,
      [
        require.resolve('typescript/bin/tsc'),
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        path.resolve('test/fixtures/types/client-manifest-methods.ts'),
      ],
      { stdio: 'pipe', timeout: 60000 }
    );
  });
});
