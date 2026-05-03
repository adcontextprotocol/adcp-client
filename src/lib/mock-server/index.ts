import { bootCreativeAdServer } from './creative-ad-server/server';
import {
  DEFAULT_API_KEY as CREATIVE_AD_SERVER_DEFAULT_API_KEY,
  NETWORKS as CREATIVE_AD_SERVER_NETWORKS,
} from './creative-ad-server/seed-data';
import { bootCreativeTemplate } from './creative-template/server';
import { DEFAULT_API_KEY as CREATIVE_TEMPLATE_DEFAULT_API_KEY, WORKSPACES } from './creative-template/seed-data';
import { bootSalesGuaranteed } from './sales-guaranteed/server';
import {
  DEFAULT_API_KEY as SALES_GUARANTEED_DEFAULT_API_KEY,
  NETWORKS as SALES_GUARANTEED_NETWORKS,
} from './sales-guaranteed/seed-data';
import { bootSalesNonGuaranteed } from './sales-non-guaranteed/server';
import {
  DEFAULT_API_KEY as SALES_NON_GUARANTEED_DEFAULT_API_KEY,
  NETWORKS as SALES_NON_GUARANTEED_NETWORKS,
} from './sales-non-guaranteed/seed-data';
import { bootSalesSocial } from './sales-social/server';
import { ADVERTISERS, OAUTH_CLIENTS } from './sales-social/seed-data';
import { bootSignalMarketplace } from './signal-marketplace/server';
import { DEFAULT_API_KEY as SIGNAL_MARKETPLACE_DEFAULT_API_KEY, OPERATORS } from './signal-marketplace/seed-data';
import { bootSponsoredIntelligence } from './sponsored-intelligence/server';
import { BRANDS as SI_BRANDS, DEFAULT_API_KEY as SI_DEFAULT_API_KEY } from './sponsored-intelligence/seed-data';

export interface MockServerOptions {
  specialism: string;
  port: number;
  apiKey?: string;
}

/**
 * How an adapter authenticates with the upstream mock. Specialism mocks
 * advertise one of these so the matrix harness can build the right
 * adapter-prompt section.
 */
export type MockServerAuth =
  | {
      kind: 'static_bearer';
      /** Bearer token attached on every API call. */
      apiKey: string;
    }
  | {
      kind: 'oauth_client_credentials';
      /** OAuth `client_id` for the `client_credentials` grant. */
      clientId: string;
      /** OAuth `client_secret` paired with `clientId`. */
      clientSecret: string;
      /** Path to the OAuth token endpoint relative to the mock URL,
       * e.g. `/oauth/token`. Adapters POST `grant_type=client_credentials`
       * with the client_id/secret to receive an access_token, then attach
       * it as Bearer on subsequent API calls. Token expires after
       * `expires_in` seconds (mock returns this in the token response);
       * adapters refresh via the same endpoint with `grant_type=refresh_token`. */
      tokenPath: string;
    };

export interface MockServerHandle {
  url: string;
  /** Auth shape this mock requires. The matrix harness branches on
   * `auth.kind` when building the adapter prompt — different shapes
   * produce different adapter-side wiring. */
  auth: MockServerAuth;
  close: () => Promise<void>;
  /** Adopter-friendly summary for boot-log printing. */
  summary: () => string;
  /** Specialism-agnostic principal-mapping table the matrix harness inlines
   * into the build prompt so Claude can wire AdCP-side identity to upstream
   * tenant/workspace ids without re-deriving them per specialism. */
  principalMapping: PrincipalMappingEntry[];
  /** Human-prose description of how the upstream gates per-tenant scope —
   * e.g. "via X-Operator-Id header" or "via path /v3/workspaces/{id}/...".
   * Surfaces in the harness prompt to make the auth-translation requirement
   * explicit. */
  principalScope: string;
}

export interface PrincipalMappingEntry {
  adcpField: string;
  adcpValue: string;
  upstreamField: string;
  upstreamValue: string;
}

/**
 * Boot a mock upstream platform for the given specialism. Returns a handle
 * the caller (CLI or matrix harness) uses to read connection details and
 * shut down cleanly.
 *
 * Adding a new specialism means adding the upstream-shape OpenAPI + seed
 * data + boot function under `src/lib/mock-server/<specialism>/` and a
 * switch case here.
 */
export async function bootMockServer(options: MockServerOptions): Promise<MockServerHandle> {
  switch (options.specialism) {
    case 'signal-marketplace': {
      const { url, close } = await bootSignalMarketplace({
        port: options.port,
        apiKey: options.apiKey,
      });
      const apiKey = options.apiKey ?? SIGNAL_MARKETPLACE_DEFAULT_API_KEY;
      return {
        url,
        auth: { kind: 'static_bearer', apiKey },
        close,
        summary: () => formatSignalMarketplaceSummary(url, apiKey),
        principalScope: 'X-Operator-Id header (required on every request)',
        principalMapping: OPERATORS.map(op => ({
          adcpField: 'account.operator',
          adcpValue: op.adcp_operator,
          upstreamField: 'X-Operator-Id',
          upstreamValue: op.operator_id,
        })),
      };
    }
    case 'creative-ad-server': {
      const { url, close } = await bootCreativeAdServer({
        port: options.port,
        apiKey: options.apiKey,
      });
      const apiKey = options.apiKey ?? CREATIVE_AD_SERVER_DEFAULT_API_KEY;
      return {
        url,
        auth: { kind: 'static_bearer', apiKey },
        close,
        summary: () => formatCreativeAdServerSummary(url, apiKey),
        principalScope: 'X-Network-Code header (required on every request)',
        principalMapping: CREATIVE_AD_SERVER_NETWORKS.map(net => ({
          adcpField: 'account.publisher',
          adcpValue: net.adcp_publisher,
          upstreamField: 'X-Network-Code',
          upstreamValue: net.network_code,
        })),
      };
    }
    case 'creative-template': {
      const { url, close } = await bootCreativeTemplate({
        port: options.port,
        apiKey: options.apiKey,
      });
      const apiKey = options.apiKey ?? CREATIVE_TEMPLATE_DEFAULT_API_KEY;
      return {
        url,
        auth: { kind: 'static_bearer', apiKey },
        close,
        summary: () => formatCreativeTemplateSummary(url, apiKey),
        principalScope: 'URL path segment /v3/workspaces/{workspace_id}/...',
        principalMapping: WORKSPACES.map(ws => ({
          adcpField: 'account.advertiser',
          adcpValue: ws.adcp_advertiser,
          upstreamField: 'path /v3/workspaces/{workspace_id}/',
          upstreamValue: ws.workspace_id,
        })),
      };
    }
    case 'sales-social': {
      const { url, close } = await bootSalesSocial({ port: options.port });
      const client = OAUTH_CLIENTS[0];
      if (!client) throw new Error('sales-social: no OAuth clients seeded');
      return {
        url,
        auth: {
          kind: 'oauth_client_credentials',
          clientId: client.client_id,
          clientSecret: client.client_secret,
          tokenPath: '/oauth/token',
        },
        close,
        summary: () => formatSalesSocialSummary(url, client),
        principalScope: 'URL path segment /v1.3/advertiser/{advertiser_id}/...',
        principalMapping: ADVERTISERS.map(adv => ({
          adcpField: 'account.advertiser',
          adcpValue: adv.adcp_advertiser,
          upstreamField: 'path /v1.3/advertiser/{advertiser_id}/',
          upstreamValue: adv.advertiser_id,
        })),
      };
    }
    case 'sales-guaranteed': {
      const { url, close } = await bootSalesGuaranteed({
        port: options.port,
        apiKey: options.apiKey,
      });
      const apiKey = options.apiKey ?? SALES_GUARANTEED_DEFAULT_API_KEY;
      return {
        url,
        auth: { kind: 'static_bearer', apiKey },
        close,
        summary: () => formatSalesGuaranteedSummary(url, apiKey),
        principalScope: 'X-Network-Code header (required on every request)',
        principalMapping: SALES_GUARANTEED_NETWORKS.map(net => ({
          adcpField: 'account.publisher',
          adcpValue: net.adcp_publisher,
          upstreamField: 'X-Network-Code',
          upstreamValue: net.network_code,
        })),
      };
    }
    case 'sponsored-intelligence': {
      const { url, close } = await bootSponsoredIntelligence({
        port: options.port,
        apiKey: options.apiKey,
      });
      const apiKey = options.apiKey ?? SI_DEFAULT_API_KEY;
      return {
        url,
        auth: { kind: 'static_bearer', apiKey },
        close,
        summary: () => formatSponsoredIntelligenceSummary(url, apiKey),
        principalScope: 'URL path segment /v1/brands/{brand_id}/...',
        principalMapping: SI_BRANDS.map(b => ({
          adcpField: 'account.brand',
          adcpValue: b.adcp_brand,
          upstreamField: 'path /v1/brands/{brand_id}/',
          upstreamValue: b.brand_id,
        })),
      };
    }
    case 'sales-non-guaranteed': {
      const { url, close } = await bootSalesNonGuaranteed({
        port: options.port,
        apiKey: options.apiKey,
      });
      const apiKey = options.apiKey ?? SALES_NON_GUARANTEED_DEFAULT_API_KEY;
      return {
        url,
        auth: { kind: 'static_bearer', apiKey },
        close,
        summary: () => formatSalesNonGuaranteedSummary(url, apiKey),
        principalScope: 'X-Network-Code header (required on every request)',
        principalMapping: SALES_NON_GUARANTEED_NETWORKS.map(net => ({
          adcpField: 'account.publisher',
          adcpValue: net.adcp_publisher,
          upstreamField: 'X-Network-Code',
          upstreamValue: net.network_code,
        })),
      };
    }
    default:
      throw new Error(
        `Unknown mock-server specialism: "${options.specialism}". Supported: signal-marketplace, creative-ad-server, creative-template, sales-social, sales-guaranteed, sales-non-guaranteed, sponsored-intelligence.`
      );
  }
}

function formatSignalMarketplaceSummary(url: string, apiKey: string): string {
  const operatorLines = OPERATORS.map(
    op =>
      `  ${op.operator_id}  →  AdCP account.operator: "${op.adcp_operator}"  (visible cohorts: ${op.visible_cohort_ids.length})`
  ).join('\n');
  return [
    `Mock signal marketplace running at ${url}`,
    ``,
    `Auth:`,
    `  Authorization: Bearer ${apiKey}`,
    `  X-Operator-Id: <operator_id> (required on every call)`,
    ``,
    `Operator mapping:`,
    operatorLines,
    ``,
    `OpenAPI spec: src/lib/mock-server/signal-marketplace/openapi.yaml`,
    `Routes:`,
    `  GET    ${url}/v2/cohorts`,
    `  GET    ${url}/v2/cohorts/{cohort_id}`,
    `  GET    ${url}/v2/destinations`,
    `  POST   ${url}/v2/activations`,
    `  GET    ${url}/v2/activations/{activation_id}`,
  ].join('\n');
}

function formatCreativeTemplateSummary(url: string, apiKey: string): string {
  const workspaceLines = WORKSPACES.map(
    ws =>
      `  ${ws.workspace_id}  →  AdCP account.advertiser: "${ws.adcp_advertiser}"  (visible templates: ${ws.visible_template_ids.length})`
  ).join('\n');
  return [
    `Mock creative-template platform running at ${url}`,
    ``,
    `Auth:`,
    `  Authorization: Bearer ${apiKey}`,
    `  Workspace scoping via URL path: /v3/workspaces/{workspace_id}/...`,
    ``,
    `Workspace mapping:`,
    workspaceLines,
    ``,
    `OpenAPI spec: src/lib/mock-server/creative-template/openapi.yaml`,
    `Routes:`,
    `  GET    ${url}/v3/workspaces/{ws}/templates`,
    `  GET    ${url}/v3/workspaces/{ws}/templates/{template_id}`,
    `  POST   ${url}/v3/workspaces/{ws}/renders`,
    `  GET    ${url}/v3/workspaces/{ws}/renders/{render_id}`,
    ``,
    `Renders are async: POST returns 202 with status="queued", then progresses`,
    `through "running" → "complete" on subsequent GETs (or "failed" on error).`,
  ].join('\n');
}

function formatSalesSocialSummary(url: string, client: { client_id: string; client_secret: string }): string {
  return [
    `Mock social platform (TikTok-flavored) running at ${url}`,
    ``,
    `Auth (OAuth 2.0 client_credentials):`,
    `  Token endpoint:  POST ${url}/oauth/token`,
    `  client_id:       ${client.client_id}`,
    `  client_secret:   ${client.client_secret}`,
    `  Then attach the issued access_token as Authorization: Bearer <token>`,
    `  Refresh via same endpoint with grant_type=refresh_token (token rotation on use).`,
    ``,
    `Path-scoped multi-tenancy: /v1.3/advertiser/{advertiser_id}/...`,
    `Resolve {advertiser_id} from AdCP-side identifier at runtime via:`,
    `  GET ${url}/_lookup/advertiser?adcp_advertiser=<adcp-side-value>`,
    `(Specific advertiser values are not exposed to adapters — see issue #1225.)`,
    ``,
    `OpenAPI spec: src/lib/mock-server/sales-social/openapi.yaml`,
    `Key routes:`,
    `  POST   ${url}/oauth/token                                                  (no auth)`,
    `  GET    ${url}/_lookup/advertiser?adcp_advertiser=<value>                  (no auth)`,
    `  GET    ${url}/_debug/traffic                                              (no auth)`,
    `  GET    ${url}/v1.3/advertiser/{advertiser_id}/info`,
    `  POST   ${url}/v1.3/advertiser/{advertiser_id}/custom_audience/create`,
    `  POST   ${url}/v1.3/advertiser/{advertiser_id}/custom_audience/upload      (hashed PII)`,
    `  POST   ${url}/v1.3/advertiser/{advertiser_id}/catalog/create`,
    `  POST   ${url}/v1.3/advertiser/{advertiser_id}/catalog/upload`,
    `  POST   ${url}/v1.3/advertiser/{advertiser_id}/creative/create`,
    `  POST   ${url}/v1.3/advertiser/{advertiser_id}/pixel/create`,
    `  POST   ${url}/v1.3/advertiser/{advertiser_id}/event/track                  (CAPI)`,
    `  POST   ${url}/v1.3/advertiser/{advertiser_id}/delivery_estimate            (forward + reverse forecast)`,
    `  POST   ${url}/v1.3/advertiser/{advertiser_id}/audience_reach_estimate`,
    `  POST   ${url}/v1.3/advertiser/{advertiser_id}/audience/{aud}/lookalike`,
  ].join('\n');
}

function formatSponsoredIntelligenceSummary(url: string, apiKey: string): string {
  const brandLines = SI_BRANDS.map(
    b =>
      `  ${b.brand_id}  →  AdCP account.brand: "${b.adcp_brand}"  (offerings: ${b.visible_offering_ids.length}, session_ttl: ${b.session_ttl_seconds}s)`
  ).join('\n');
  return [
    `Mock sponsored-intelligence brand-agent platform running at ${url}`,
    ``,
    `Auth:`,
    `  Authorization: Bearer ${apiKey}`,
    `  Brand scoping via URL path: /v1/brands/{brand_id}/...`,
    ``,
    `Brand mapping:`,
    brandLines,
    ``,
    `OpenAPI spec: src/lib/mock-server/sponsored-intelligence/openapi.yaml`,
    `Routes:`,
    `  GET    ${url}/_lookup/brand?adcp_brand=<value>                                (no auth)`,
    `  GET    ${url}/_debug/traffic                                                  (no auth)`,
    `  GET    ${url}/v1/brands/{brand}/offerings/{offering_id}                       # si_get_offering`,
    `  POST   ${url}/v1/brands/{brand}/conversations                                 # si_initiate_session`,
    `  GET    ${url}/v1/brands/{brand}/conversations/{conv_id}                       # read state`,
    `  POST   ${url}/v1/brands/{brand}/conversations/{conv_id}/turns                 # si_send_message`,
    `  POST   ${url}/v1/brands/{brand}/conversations/{conv_id}/close                 # si_terminate_session`,
    ``,
    `Conversation lifecycle: active → closed (terminal). Re-closing returns the`,
    `same payload — naturally idempotent on conversation_id, mirroring AdCP's`,
    `decision to omit idempotency_key on si_terminate_session. POST /conversations`,
    `and POST /turns each accept client_request_id for at-most-once execution.`,
    `Brand "agent" routes user messages by keyword (buy/checkout → transaction`,
    `handoff hint, thanks/bye → complete hint) — deterministic for fixtures.`,
  ].join('\n');
}

function formatSalesGuaranteedSummary(url: string, apiKey: string): string {
  const networkLines = SALES_GUARANTEED_NETWORKS.map(
    net => `  ${net.network_code}  →  AdCP account.publisher: "${net.adcp_publisher}"`
  ).join('\n');
  return [
    `Mock guaranteed-sales platform (GAM-flavored) running at ${url}`,
    ``,
    `Auth:`,
    `  Authorization: Bearer ${apiKey}`,
    `  X-Network-Code: <network_code> (required on every call)`,
    ``,
    `Network mapping:`,
    networkLines,
    ``,
    `OpenAPI spec: src/lib/mock-server/sales-guaranteed/openapi.yaml`,
    `Key routes:`,
    `  GET    ${url}/v1/inventory                                                # ad units`,
    `  GET    ${url}/v1/products                                                 # productized inventory`,
    `  GET    ${url}/v1/products?targeting=…&flight_start=…&budget=…             # products with per-query forecast`,
    `  POST   ${url}/v1/forecast                                                 # GAM-style getDeliveryForecast`,
    `  POST   ${url}/v1/availability                                             # multi-item availability dry-run`,
    `  GET    ${url}/v1/orders                                                   # list orders`,
    `  POST   ${url}/v1/orders                                                   # create (returns pending_approval + task_id)`,
    `  GET    ${url}/v1/orders/{order_id}                                        # poll order status`,
    `  POST   ${url}/v1/orders/{order_id}/lineitems                              # add line items`,
    `  POST   ${url}/v1/orders/{order_id}/lineitems/{li}/creative-attach         # attach creative`,
    `  GET    ${url}/v1/orders/{order_id}/delivery                               # delivery reporting`,
    `  POST   ${url}/v1/orders/{order_id}/conversions                            # CAPI delivery validation`,
    `  GET    ${url}/v1/tasks/{task_id}                                          # poll approval task`,
    `  GET    ${url}/v1/creatives                                                # list creatives`,
    `  POST   ${url}/v1/creatives                                                # upload creative`,
    ``,
    `Order state machine: draft → pending_approval → approved → delivering → completed`,
    `Approval is async: POST /orders returns pending_approval + approval_task_id;`,
    `poll /tasks/{id} (mock auto-promotes submitted → working → completed after 2 polls)`,
    `or poll /orders/{id} directly to detect transition.`,
  ].join('\n');
}

function formatCreativeAdServerSummary(url: string, apiKey: string): string {
  const networkLines = CREATIVE_AD_SERVER_NETWORKS.map(
    net => `  ${net.network_code}  →  AdCP account.publisher: "${net.adcp_publisher}"`
  ).join('\n');
  return [
    `Mock creative ad server (stateful library + tag generation) running at ${url}`,
    ``,
    `Auth:`,
    `  Authorization: Bearer ${apiKey}`,
    `  X-Network-Code: <network_code> (required on every /v1 call)`,
    ``,
    `Network mapping:`,
    networkLines,
    ``,
    `Key routes:`,
    `  GET    ${url}/v1/formats                                                  # format catalog`,
    `  GET    ${url}/v1/creatives                                                # list (filter: advertiser_id, format_id, status, created_after, creative_ids; cursor pagination)`,
    `  POST   ${url}/v1/creatives                                                # write to library; format auto-detect from upload_mime if format_id omitted`,
    `  GET    ${url}/v1/creatives/{id}                                           # single fetch`,
    `  PATCH  ${url}/v1/creatives/{id}                                           # update snippet/status/click_url/name`,
    `  POST   ${url}/v1/creatives/{id}/render                                    # tag generation; macro substitution; returns tag_html + tag_url`,
    `  GET    ${url}/v1/creatives/{id}/delivery?start=&end=                      # synth impressions/clicks; CTR baselines per format`,
    `  GET    ${url}/serve/{id}?ctx=<json>                                       # real iframe-embeddable HTML (no auth — capability-by-id)`,
    ``,
    `Macros substituted at render time: {click_url}, {impression_pixel}, {cb},`,
    `{advertiser_id}, {creative_id}, {asset_url}, {width}, {height}, {duration_seconds}.`,
    `CTR baselines: display ~0.10%, video ~1.5%, ctv ~3%, audio ~0.5%.`,
  ].join('\n');
}

function formatSalesNonGuaranteedSummary(url: string, apiKey: string): string {
  const networkLines = SALES_NON_GUARANTEED_NETWORKS.map(
    net => `  ${net.network_code}  →  AdCP account.publisher: "${net.adcp_publisher}"`
  ).join('\n');
  return [
    `Mock non-guaranteed-sales platform (programmatic remnant) running at ${url}`,
    ``,
    `Auth:`,
    `  Authorization: Bearer ${apiKey}`,
    `  X-Network-Code: <network_code> (required on every call)`,
    ``,
    `Network mapping:`,
    networkLines,
    ``,
    `Key routes:`,
    `  GET    ${url}/v1/inventory                                                # ad units`,
    `  GET    ${url}/v1/products                                                 # productized inventory (floor pricing)`,
    `  GET    ${url}/v1/products?targeting=…&flight_start=…&budget=…             # products with per-query forecast`,
    `  POST   ${url}/v1/forecast                                                 # spend-only forecast (auction-clearing)`,
    `  GET    ${url}/v1/orders                                                   # list orders`,
    `  POST   ${url}/v1/orders                                                   # create (sync confirmed — no HITL)`,
    `  GET    ${url}/v1/orders/{order_id}                                        # read order`,
    `  PATCH  ${url}/v1/orders/{order_id}                                        # update budget / pacing / status`,
    `  POST   ${url}/v1/orders/{order_id}/lineitems                              # add line items`,
    `  GET    ${url}/v1/orders/{order_id}/delivery                               # delivery (budget × pacing curve)`,
    `  GET    ${url}/v1/creatives                                                # list creatives`,
    `  POST   ${url}/v1/creatives                                                # upload creative`,
    ``,
    `Order state machine: confirmed → delivering → completed (no approval task).`,
    `Pricing: per-product min_cpm (floor); effective_cpm scales with budget,`,
    `saturating toward 2× floor at high budgets (auction pressure model).`,
    `Pacing: 'even' (linear), 'asap' (3× front-load), 'front_loaded' (sqrt curve).`,
    `Delivery synthesis: (budget × elapsed_pct × pacing_curve) → impressions / clicks.`,
  ].join('\n');
}
