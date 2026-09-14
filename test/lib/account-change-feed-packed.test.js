const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

// This intentionally packs and loads the published artifact, not source schemas
// or the checkout's dist facade. The same behavioral suite runs in that package.
test('packed account feed MCP schema, runtime semantics and cursor types', { timeout: 180000 }, async () => {
  const repo = path.resolve(__dirname, '../..');
  const temp = mkdtempSync(path.join(tmpdir(), 'adcp-account-feed-'));
  try {
    const { parseNpmPackOutput } = await import('../../scripts/check-package-size.mjs');
    const output = parseNpmPackOutput(
      execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp], {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    );
    execFileSync('tar', ['-xzf', path.join(temp, output[0].filename), '-C', temp]);
    const packed = path.join(temp, 'package');
    mkdirSync(path.join(temp, 'node_modules', '@adcp'), { recursive: true });
    symlinkSync(packed, path.join(temp, 'node_modules', '@adcp', 'sdk'), 'dir');
    symlinkSync(path.join(repo, 'node_modules'), path.join(packed, 'node_modules'), 'dir');
    const requirePacked = createRequire(path.join(temp, 'consumer.cjs'));
    const sdk = requirePacked('@adcp/sdk');
    const { createAdcpServer } = requirePacked('@adcp/sdk/server/legacy/v5');
    assert.equal(
      requirePacked('@adcp/sdk/webhooks').parseAccountChangeNotification,
      sdk.parseAccountChangeNotification
    );
    assert.equal(requirePacked('@adcp/sdk/client').streamAccountChanges, sdk.streamAccountChanges);
    let calls = 0;
    const now = '2026-08-24T11:58:04Z';
    const server = createAdcpServer({
      name: 'packed-account-feed',
      version: '1.0.0',
      stateStore: new sdk.InMemoryStateStore(),
      exposeToolSchemas: true,
      validation: { requests: 'off', responses: 'off' },
      accounts: {
        listAccountChanges: async request => {
          calls++;
          if (request.cursor === 'expired')
            return sdk.adcpError('CURSOR_EXPIRED', {
              message: 'Rebootstrap required',
              recovery: 'correctable',
              details: { reason: 'authorization_scope_changed', restart_with: { starting_position: 'latest' } },
            });
          return {
            status: 'completed',
            changes: [],
            cursor: 'tail',
            has_more: false,
            available_since: now,
            generated_at: now,
          };
        },
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'packed-feed-test', version: '1.0.0' });
    await client.connect(clientTransport);
    try {
      const catalog = await client.listTools();
      const tool = catalog.tools.find(tool => tool.name === 'list_account_changes');
      assert.ok(tool, 'list_account_changes must appear in the emitted MCP catalog');
      assert.equal(tool.inputSchema.type, 'object');
      assert.ok(tool.inputSchema.properties.account);
      for (const combinator of ['oneOf', 'anyOf', 'allOf'])
        assert.equal(Object.hasOwn(tool.inputSchema, combinator), false);
      const invalid = await client.callTool({
        name: 'list_account_changes',
        arguments: { account: { account_id: 'acc_luma_shared' }, cursor: 'c0', starting_position: 'latest' },
      });
      assert.equal(invalid.structuredContent.adcp_error.code, 'INVALID_REQUEST');
      assert.equal(invalid.structuredContent.adcp_error.field, 'starting_position');
      assert.equal(calls, 0, 'semantic exclusion must precede handler even with validation off');
      const agent = sdk.AgentClient.fromMCPClient(client, {
        agentName: 'packed-seller',
        validateFeatures: false,
        validation: { requests: 'strict', responses: 'strict' },
      });
      const empty = await agent.listAccountChanges({
        account: { account_id: 'acc_luma_shared' },
        starting_position: 'latest',
      });
      assert.equal(empty.success, true, JSON.stringify(empty));
      assert.equal(empty.data.cursor, 'tail');
      const expired = await agent.listAccountChanges({ account: { account_id: 'acc_luma_shared' }, cursor: 'expired' });
      assert.equal(expired.success, false);
      assert.equal(expired.adcpError.code, 'CURSOR_EXPIRED', JSON.stringify(expired));
      await assert.rejects(
        sdk
          .streamAccountChanges(agent, {
            account: { account_id: 'acc_luma_shared' },
            cursor: sdk.restoreAccountChangeCursor('expired'),
          })
          .next(),
        sdk.AccountChangeCursorExpiredError
      );
    } finally {
      await client.close();
      await server.close();
    }
    execFileSync(
      process.execPath,
      ['--test', '--test-timeout=60000', path.join(repo, 'test/lib/account-change-feed.test.js')],
      { env: { ...process.env, ADCP_TEST_PACKAGE_ROOT: packed }, stdio: 'pipe' }
    );
    writeFileSync(
      path.join(temp, 'consumer.ts'),
      `
import { streamAccountChanges, restoreAccountChangeCursor, parseAccountChangeNotification, buildAccountChangeSubscriptionRequest, type AgentClient, type DurableAccountChangeCursor, type AdvisoryThroughCursor, type AccountChangeRecordedWebhook, type AccountChangeFailure, type AccountChangePage, type AccountChangeSourceCoverage } from '@adcp/sdk';
declare const client: AgentClient;
declare const advisory: AdvisoryThroughCursor;
// @ts-expect-error Advisory targets are not durable checkpoint identities.
const durable: DurableAccountChangeCursor = advisory;
// @ts-expect-error Advisory targets cannot be passed to the raw wire cursor either.
client.listAccountChanges({account: {account_id:'acc'}, cursor: advisory});
// @ts-expect-error Rehydration takes persisted bytes, not an advisory object.
restoreAccountChangeCursor(advisory);
// @ts-expect-error The guarded stream rejects advisory checkpoint installation.
streamAccountChanges(client, {account: {account_id:'acc'}, cursor: advisory});
async function drain() {
  const request = buildAccountChangeSubscriptionRequest({account: {account_id:'acc'}, currentConfigs: [], subscriber: {subscriber_id:'primary', url:'https://buyer.example/hooks'}});
  await client.syncAccounts(request);
  const caps = await client.getCapabilities();
  if (caps.account?.changeFeed?.supported) {
    const read: 'list_account_changes' = caps.account.changeFeed.read_task;
  }
  for await (const page of streamAccountChanges(client, {account: {account_id:'acc'}, cursor: restoreAccountChangeCursor('persisted')})) {
    await page.acknowledge(async cursor => { const value: string = cursor.value; });
  }
}
`
    );
    execFileSync(
      process.execPath,
      [
        path.join(repo, 'node_modules/typescript/bin/tsc'),
        '--strict',
        '--skipLibCheck',
        '--noEmit',
        '--target',
        'ES2022',
        '--module',
        'Node16',
        '--moduleResolution',
        'Node16',
        path.join(temp, 'consumer.ts'),
      ],
      { cwd: temp, stdio: 'pipe' }
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
