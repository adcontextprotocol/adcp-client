/**
 * CI gates for `examples/hello_si_adapter_brand.ts`.
 *
 * Three independent assertions via the shared helper:
 *   1. The example typechecks under the strictest realistic adopter config.
 *   2. With the published sponsored-intelligence mock as upstream, the
 *      `si_baseline` protocol storyboard
 *      (`compliance/cache/latest/protocols/sponsored-intelligence/index.yaml`)
 *      reports zero failed steps.
 *   3. After the run, every expected upstream route shows ≥1 hit at
 *      /_debug/traffic — the façade-resistance gate.
 *
 * Note: SI is a *protocol* in AdCP 3.0, not a specialism (tracked at
 * adcontextprotocol/adcp#3961 for 3.1). The compliance storyboard lives at
 * `protocols/sponsored-intelligence/` rather than `specialisms/`. The
 * runHelloAdapterGates helper drives the storyboard by id regardless.
 */

const path = require('node:path');
const { runHelloAdapterGates } = require('./_helpers/runHelloAdapterGates');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

runHelloAdapterGates({
  suiteName: 'examples/hello_si_adapter_brand',
  exampleFile: path.join(REPO_ROOT, 'examples', 'hello_si_adapter_brand.ts'),
  specialism: 'sponsored-intelligence',
  storyboardId: 'si_baseline',
  adcpAuthToken: 'sk_harness_do_not_use_in_prod',
  mockOptions: { apiKey: 'mock_si_brand_key_do_not_use_in_prod' },
  extraEnv: { UPSTREAM_API_KEY: 'mock_si_brand_key_do_not_use_in_prod' },
  expectedRoutes: [
    'GET /v1/brands/{brand}/offerings/{id}',
    'POST /v1/brands/{brand}/conversations',
    'POST /v1/brands/{brand}/conversations/{id}/turns',
    'POST /v1/brands/{brand}/conversations/{id}/close',
  ],
});
