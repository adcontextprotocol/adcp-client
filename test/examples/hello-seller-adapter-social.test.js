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
const assert = require('node:assert/strict');
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
    'GET /v1.3/advertiser/{id}/info',
    'POST /v1.3/advertiser/{id}/custom_audience/create',
    'POST /v1.3/advertiser/{id}/creative/create',
    'POST /v1.3/advertiser/{id}/catalog/create',
    'POST /v1.3/advertiser/{id}/catalog/upload',
    // 3.1.0-beta.3's sales_social storyboard still skips event_setup and
    // event_logging after the optional preview_creative stateful step is
    // skipped, so those upstream routes stay out of this façade gate until
    // the storyboard executes those steps again. Financials are asserted by
    // the direct MCP gate below.
  ],
  extraMcpAssertions: [
    {
      label: 'directly exercises 3.1 account financials against the upstream info route',
      run: async ({ callTool }) => {
        const result = await callTool('get_account_financials', {
          account: {
            brand: { domain: 'acmeoutdoor.example' },
            operator: 'pinnacle-agency.example',
            sandbox: true,
          },
        });
        assert.equal(result?.structuredContent?.status, 'completed', JSON.stringify(result));
        assert.equal(result?.structuredContent?.currency, 'USD');
        assert.equal(result?.structuredContent?.timezone, 'America/Los_Angeles');
        assert.equal(result?.structuredContent?.spend?.total_spend, 0);
      },
    },
    {
      label: 'directly exercises 3.1 sync_accounts billing dispatch',
      run: async ({ callTool }) => {
        const caps = await callTool('get_adcp_capabilities', {});
        assert.deepEqual(caps?.structuredContent?.account?.supported_billing, ['operator', 'agent']);

        const perAgentReject = await callTool('sync_accounts', {
          idempotency_key: 'hello-social-agent-billing-reject',
          accounts: [
            {
              brand: { domain: 'acmeoutdoor.example' },
              operator: 'pinnacle-agency.example',
              billing: 'agent',
              sandbox: true,
            },
          ],
        });
        const perAgentRow = perAgentReject?.structuredContent?.accounts?.[0];
        assert.equal(perAgentRow?.action, 'failed', JSON.stringify(perAgentReject));
        assert.equal(perAgentRow?.errors?.[0]?.code, 'BILLING_NOT_PERMITTED_FOR_AGENT');
        assert.equal(perAgentRow?.errors?.[0]?.details?.rejected_billing, 'agent');
        assert.equal(perAgentRow?.errors?.[0]?.details?.suggested_billing, 'operator');

        const capabilityReject = await callTool('sync_accounts', {
          idempotency_key: 'hello-social-cap-billing-reject',
          accounts: [
            {
              brand: { domain: 'acmeoutdoor.example' },
              operator: 'pinnacle-agency.example',
              billing: 'advertiser',
              sandbox: true,
            },
          ],
        });
        const capabilityRow = capabilityReject?.structuredContent?.accounts?.[0];
        assert.equal(capabilityRow?.action, 'failed', JSON.stringify(capabilityReject));
        assert.equal(capabilityRow?.errors?.[0]?.code, 'BILLING_NOT_SUPPORTED');
        assert.equal(capabilityRow?.errors?.[0]?.details?.scope, 'capability');

        const recovered = await callTool('sync_accounts', {
          idempotency_key: 'hello-social-agent-billing-recover',
          accounts: [
            {
              brand: { domain: 'acmeoutdoor.example' },
              operator: 'pinnacle-agency.example',
              billing: 'operator',
              sandbox: true,
            },
          ],
        });
        const recoveredRow = recovered?.structuredContent?.accounts?.[0];
        assert.equal(recoveredRow?.status, 'active', JSON.stringify(recovered));
        assert.equal(recoveredRow?.billing, 'operator');
      },
    },
  ],
});
