/**
 * CI gates for `examples/hello_creative_adapter_ad_server.ts`.
 *
 * Three independent assertions via the shared helper. Storyboard runner
 * drives `creative_ad_server` with `controller_seeding: true` — the
 * adapter's `complyTest.seed.creative` adapter forwards seeded creatives
 * to the upstream library so list / build steps find them.
 */

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { runHelloAdapterGates } = require('./_helpers/runHelloAdapterGates');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Enable the mock server's TEST-ONLY `creative_id` override path so the
// storyboard's `controller_seeding: true` fixtures land under the declared
// alias (`campaign_hero_video`, etc.). Default-off; without this env the
// mock generates a fresh server id and the storyboard fails (loud — not
// silent — by design).
process.env.MOCK_ALLOW_CREATIVE_ID_OVERRIDE = '1';

runHelloAdapterGates({
  suiteName: 'examples/hello_creative_adapter_ad_server',
  exampleFile: path.join(REPO_ROOT, 'examples', 'hello_creative_adapter_ad_server.ts'),
  specialism: 'creative-ad-server',
  storyboardId: 'creative_ad_server',
  adcpAuthToken: 'sk_harness_do_not_use_in_prod',
  mockOptions: { apiKey: 'mock_creative_ad_server_key_do_not_use_in_prod' },
  extraEnv: {
    UPSTREAM_API_KEY: 'mock_creative_ad_server_key_do_not_use_in_prod',
  },
  extraMcpAssertions: [
    {
      label: 'projects the canonical creative library onto the legacy 3.1 list_creatives schema',
      run: async ({ callTool }) => {
        const account = { account_id: 'acct_acme_creative' };
        const legacy = await callTool('list_creatives', { adcp_version: '3.1', account, fields: ['format_id'] });
        assert.ok(legacy?.structuredContent?.creatives?.[0]?.format_id, JSON.stringify(legacy));
        assert.equal(legacy.structuredContent.creatives[0].format_kind, undefined);
      },
    },
  ],
  expectedRoutes: ['GET /_lookup/network', 'GET /v1/creatives', 'POST /v1/creatives/{id}/render'],
});

void test;
