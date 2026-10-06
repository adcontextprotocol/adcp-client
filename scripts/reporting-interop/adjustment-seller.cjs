'use strict';

// Real installed SDK stores/runtime, served through its official MCP server.
// This isolated fixture accepts canonical account IDs so durable Python plans
// reach the seller unchanged, without adding sandbox fields to frozen bodies.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createInterface } = require('node:readline');
const { createFixture } = require('./managed-seller.cjs');
const ACCOUNT = 'reporting_core_lab';
const sha = value => createHash('sha256').update(value).digest('hex');

async function main() {
  const input = createInterface({ input: process.stdin });
  const settings = JSON.parse(await new Promise(resolve => input.once('line', resolve)));
  input.close();
  const req = createRequire(path.join(settings.installation, 'package.json'));
  const lock = JSON.parse(fs.readFileSync(path.join(settings.installation, 'package-lock.json')));
  const installed = req('@adcp/sdk/package.json');
  assert.equal(installed.version, lock.packages['node_modules/@adcp/sdk'].version);
  assert.equal(lock.packages['node_modules/@adcp/sdk'].integrity, settings.integrity);
  const sdk = req('@adcp/sdk');
  const api = {
    ledger: req('@adcp/sdk/reporting/ledger'),
    server: req('@adcp/sdk/server'),
    schemas: req('@adcp/sdk/schemas'),
    jcs: { canonicalize: sdk.canonicalize },
  };
  const pool = new (req('pg').Pool)({
    connectionString: process.env.DATABASE_URL,
    options: '-c search_path=seller',
    max: 4,
  });
  let server;
  let cleanup;
  const close = () =>
    (cleanup ??= (async () => {
      try {
        if (server) await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
      } finally {
        await pool.end();
      }
    })());
  try {
    await pool.query('CREATE SCHEMA seller');
    const fixture = await createFixture(api, pool, { mode: 'billing', adjustments: true });
    await fixture.controller('reliable_reporting_reconciled_billing_probe', 'prepare');
    await fixture.appendAdjustments(['integer_delta', 'exact_decimal']);
    const authenticate = api.server.verifyApiKey({
      verify(token) {
        const entry = settings.principals.find(value => value.token === token);
        return entry
          ? { principal: entry.id, extra: { consumer_id: entry.consumer_id, controller: entry.controller } }
          : null;
      },
    });
    const context = (request, extra) => {
      assert.equal(request.account?.account_id, ACCOUNT, 'authorized canonical account');
      assert.ok(extra.authInfo?.extra?.consumer_id, 'authenticated consumer');
      return { account: { account_id: ACCOUNT }, consumer_id: extra.authInfo.extra.consumer_id };
    };
    const respond = result => ({
      content: [{ type: 'text', text: 'Reporting operation completed' }],
      structuredContent: { status: 'completed', ...api.server.toStructuredContent(result) },
    });
    const createAgent = () => {
      const agent = api.server.createTaskCapableServer('Installed adjustment interop seller', '1.0.0');
      for (const [tool, method] of [
        ['get_reporting_status', 'getReportingStatus'],
        ['get_media_buy_delivery', 'getMediaBuyDelivery'],
        ['sync_reporting_receipts', 'syncReportingReceipts'],
      ]) {
        agent.registerTool(tool, { inputSchema: api.schemas.TOOL_INPUT_SHAPES[tool] }, async (request, extra) => {
          const scoped = context(request, extra);
          if (tool === 'sync_reporting_receipts') {
            fs.appendFileSync(
              settings.audit,
              JSON.stringify({
                consumer_id: scoped.consumer_id,
                request_sha256: sha(Buffer.from(sdk.canonicalize(request))),
                idempotency_key: request.idempotency_key,
              }) + '\n'
            );
          }
          return respond(await fixture.runtime[method](request, scoped));
        });
      }
      agent.registerTool(
        'comply_test_controller',
        { inputSchema: api.server.TOOL_INPUT_SHAPE },
        async (request, extra) => {
          assert.equal(extra.authInfo?.extra?.controller, true, 'controller authorization');
          assert.equal(request.scenario, 'reliable_reporting_reconciled_billing_probe');
          assert.equal(request.params?.operation, 'publish_adjustment');
          await fixture.appendAdjustments(['unicode_composed']);
          return respond({ success: true, simulated: { adjustment_committed: true } });
        }
      );
      return agent;
    };
    await new Promise((resolve, reject) => {
      server = api.server.serve(createAgent, {
        authenticate,
        allowedHosts: ['127.0.0.1', 'localhost'],
        path: '/mcp',
        port: settings.port,
        onListening() {
          fs.writeFileSync(
            settings.ready,
            JSON.stringify({
              pid: process.pid,
              port: settings.port,
              version: installed.version,
              integrity: settings.integrity,
              startup_proof_sha256: sha(settings.proof),
              auth_bindings: settings.principals.map(value => ({ id: value.id, sha256: sha(value.token) })),
            }),
            { flag: 'wx', mode: 0o600 }
          );
          resolve();
        },
      });
      server.on('error', reject);
    });
    for (const signal of ['SIGTERM', 'SIGINT'])
      process.once(signal, () =>
        close().catch(() => {
          process.exitCode = 1;
        })
      );
  } catch (error) {
    await close();
    throw error;
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'failed', error_type: error?.name }));
  process.exitCode = 1;
});
