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
const { runHelloAdapterGates } = require('./_helpers/runHelloAdapterGates');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

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
  expectedRoutes: ['GET /_lookup/network', 'GET /v1/creatives', 'POST /v1/creatives/{id}/render'],
});

void test;
