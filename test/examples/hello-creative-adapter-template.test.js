/**
 * CI gates for `examples/hello_creative_adapter_template.ts`.
 *
 * Three independent assertions via the shared helper:
 *   1. The example typechecks under the strictest realistic adopter config.
 *   2. With the published creative-template mock as upstream, the storyboard
 *      runner reports zero failed steps.
 *   3. After the run, every expected upstream route shows ≥1 hit at
 *      /_debug/traffic — the façade-resistance gate.
 */

const path = require('node:path');
const { runHelloAdapterGates } = require('./_helpers/runHelloAdapterGates');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

runHelloAdapterGates({
  suiteName: 'examples/hello_creative_adapter_template',
  exampleFile: path.join(REPO_ROOT, 'examples', 'hello_creative_adapter_template.ts'),
  specialism: 'creative-template',
  storyboardId: 'creative_template',
  adcpAuthToken: 'sk_harness_do_not_use_in_prod',
  agentPort: 35002,
  upstreamPort: 41502,
  mockOptions: { apiKey: 'mock_creative_template_key_do_not_use_in_prod' },
  extraEnv: { UPSTREAM_API_KEY: 'mock_creative_template_key_do_not_use_in_prod' },
  expectedRoutes: [
    'GET /_lookup/workspace',
    'GET /v3/workspaces/{ws}/templates',
    'POST /v3/workspaces/{ws}/renders',
    'GET /v3/workspaces/{ws}/renders/{id}',
  ],
});
