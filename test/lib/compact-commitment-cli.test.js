const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { serve } = require('../../dist/lib/index.js');
const { createAdcpServer } = require('../../dist/lib/server/legacy/v5/index.js');

const CLI = path.resolve(__dirname, '../../bin/adcp.js');
const DIGEST = `sha256:${'A'.repeat(43)}`;
let home;
let previousNodeEnv;
let server;
let url;

function compactCommitmentResponse() {
  return {
    status: 'completed',
    media_buy_id: 'mb-1',
    revision: 1,
    accepted_proposal: {
      proposal_id: 'proposal-1',
      proposal_kind: 'new_media_buy',
      proposal_status: 'accepted',
      media_buy_id: 'mb-1',
      accepted_at: '2026-08-18T12:00:00Z',
      name: 'Accepted proposal',
      commercial_terms: {
        brand: { domain: 'example.com' },
        purchases: [
          {
            product_id: 'product-1',
            pricing_option_id: 'price-1',
            pricing: {
              pricing_option_id: 'price-1',
              pricing_model: 'cpm',
              currency: 'USD',
              fixed_price: 10,
            },
            start_time: '2026-08-19T00:00:00Z',
            end_time: '2026-09-01T00:00:00Z',
          },
        ],
        start_time: '2026-08-19T00:00:00Z',
        end_time: '2026-09-01T00:00:00Z',
      },
      terms_digest: DIGEST,
    },
    purchase_bindings: [{ purchase_index: 0, product_id: 'product-1', package_id: 'package-1' }],
    available_actions: [],
  };
}

function waitForListening(server) {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

function closeServer(server) {
  server.closeAllConnections();
  return new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
}

function runCli(args, home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.once('error', reject);
    const timer = setTimeout(() => child.kill('SIGKILL'), 45_000);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-compact-cli-'));
  previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  server = serve(
    () =>
      createAdcpServer({
        name: 'Compact commitment seller',
        version: '1.0.0',
        adcpVersion: '3.2.0-beta.10',
        idempotency: 'disabled',
        validation: { requests: 'strict', responses: 'strict' },
        mediaBuy: {
          buyProducts: async () => compactCommitmentResponse(),
          acceptProposal: async () => compactCommitmentResponse(),
        },
      }),
    {
      port: 0,
      authenticate: () => ({ principal: 'cli-regression-buyer' }),
      onListening: () => {},
    }
  );
  await waitForListening(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  url = `http://127.0.0.1:${address.port}/mcp`;
});

after(async () => {
  if (server) {
    await closeServer(server);
  }
  if (home) {
    fs.rmSync(home, { recursive: true, force: true });
  }
  if (previousNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = previousNodeEnv;
  }
});

const calls = [
  [
    'buy_products',
    {
      idempotency_key: 'buy-products-2594-0001',
      account: { account_id: 'account-1' },
      brand: { domain: 'example.com' },
      feed_version: 'feed-1',
      purchases: [{ product_id: 'product-1', pricing_option_id: 'price-1' }],
      start_time: '2026-08-19T00:00:00Z',
      end_time: '2026-09-01T00:00:00Z',
    },
  ],
  [
    'accept_proposal',
    {
      idempotency_key: 'accept-proposal-2594-0001',
      account: { account_id: 'account-1' },
      proposal_id: 'proposal-1',
      proposal_terms_digest: DIGEST,
    },
  ],
];

for (const [tool, payload] of calls) {
  test(`beta createAdcpServer ${tool} response passes CLI validation`, async () => {
    const result = await runCli(
      [url, tool, JSON.stringify(payload), '--protocol', 'mcp', '--allow-http', '--json'],
      home
    );
    assert.strictEqual(
      result.code,
      0,
      `${tool} CLI failed (${result.signal ?? 'no signal'}):\n${result.stderr}\n${result.stdout}`
    );
    assert.doesNotMatch(result.stderr, /Schema validation failed/, `${tool}: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.strictEqual(output.data.adcp_version, '3.2-beta.10');
    assert.strictEqual(output.data.media_buy_id, 'mb-1');
  });
}
