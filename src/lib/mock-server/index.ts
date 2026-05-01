import { bootCreativeTemplate } from './creative-template/server';
import { DEFAULT_API_KEY as CREATIVE_TEMPLATE_DEFAULT_API_KEY, WORKSPACES } from './creative-template/seed-data';
import { bootSalesGuaranteed } from './sales-guaranteed/server';
import {
  DEFAULT_API_KEY as SALES_GUARANTEED_DEFAULT_API_KEY,
  NETWORKS as SALES_GUARANTEED_NETWORKS,
} from './sales-guaranteed/seed-data';
import { bootSalesSocial } from './sales-social/server';
import { ADVERTISERS, OAUTH_CLIENTS } from './sales-social/seed-data';
import { bootSignalMarketplace } from './signal-marketplace/server';
import { DEFAULT_API_KEY as SIGNAL_MARKETPLACE_DEFAULT_API_KEY, OPERATORS } from './signal-marketplace/seed-data';

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
    default:
      throw new Error(
        `Unknown mock-server specialism: "${options.specialism}". Supported: signal-marketplace, creative-template, sales-social, sales-guaranteed.`
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
  const advertiserLines = ADVERTISERS.map(
    adv => `  ${adv.advertiser_id}  →  AdCP account.advertiser: "${adv.adcp_advertiser}"`
  ).join('\n');
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
    `Advertiser mapping (path-scoped):`,
    advertiserLines,
    ``,
    `OpenAPI spec: src/lib/mock-server/sales-social/openapi.yaml`,
    `Key routes:`,
    `  POST   ${url}/oauth/token                                                  (no auth)`,
    `  GET    ${url}/v1.3/advertiser/{advertiser_id}/info`,
    `  POST   ${url}/v1.3/advertiser/{advertiser_id}/custom_audience/create`,
    `  POST   ${url}/v1.3/advertiser/{advertiser_id}/custom_audience/upload      (hashed PII)`,
    `  POST   ${url}/v1.3/advertiser/{advertiser_id}/catalog/create`,
    `  POST   ${url}/v1.3/advertiser/{advertiser_id}/catalog/upload`,
    `  POST   ${url}/v1.3/advertiser/{advertiser_id}/creative/create`,
    `  POST   ${url}/v1.3/advertiser/{advertiser_id}/pixel/create`,
    `  POST   ${url}/v1.3/advertiser/{advertiser_id}/event/track                  (CAPI)`,
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
