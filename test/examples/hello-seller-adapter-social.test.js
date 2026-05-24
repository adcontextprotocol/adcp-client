/**
 * CI gates for `examples/hello_seller_adapter_social.ts`.
 *
 * Three independent assertions via the shared helper:
 *   1. The example typechecks under the strictest realistic adopter config.
 *   2. With the published sales-social mock as upstream, the storyboard
 *      runner reports zero failed steps.
 *   3. After the run, every expected upstream route shows ≥1 hit at
 *      /_debug/traffic — the façade-resistance gate.
 */

const path = require('node:path');
const { runHelloAdapterGates } = require('./_helpers/runHelloAdapterGates');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// sales-social mock issues OAuth tokens via /oauth/token; client_id and
// client_secret are seeded constants in the mock package. These match the
// example's defaults — adopter forks should override via env vars.
const UPSTREAM_OAUTH_CLIENT_ID = 'walled_garden_test_client_001';
const UPSTREAM_OAUTH_CLIENT_SECRET = 'walled_garden_test_secret_do_not_use_in_prod';

runHelloAdapterGates({
  suiteName: 'examples/hello_seller_adapter_social',
  exampleFile: path.join(REPO_ROOT, 'examples', 'hello_seller_adapter_social.ts'),
  specialism: 'sales-social',
  storyboardId: 'sales_social',
  adcpAuthToken: 'sk_harness_do_not_use_in_prod',
  extraEnv: {
    UPSTREAM_OAUTH_CLIENT_ID,
    UPSTREAM_OAUTH_CLIENT_SECRET,
  },
  expectedRoutes: [
    'POST /oauth/token',
    'GET /_lookup/advertiser',
    'POST /v1.3/advertiser/{id}/custom_audience/create',
    'POST /v1.3/advertiser/{id}/creative/create',
    'POST /v1.3/advertiser/{id}/catalog/create',
    'POST /v1.3/advertiser/{id}/catalog/upload',
    // 3.1.0-beta.3's sales_social storyboard skips event_setup,
    // event_logging, and financials after the optional preview_creative
    // stateful step is skipped, so those upstream routes are not part of
    // this façade gate until the storyboard executes those steps again.
  ],
});
