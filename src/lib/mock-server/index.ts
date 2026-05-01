import { bootCreativeTemplate } from './creative-template/server';
import { DEFAULT_API_KEY as CREATIVE_TEMPLATE_DEFAULT_API_KEY, WORKSPACES } from './creative-template/seed-data';
import { bootSignalMarketplace } from './signal-marketplace/server';
import { DEFAULT_API_KEY as SIGNAL_MARKETPLACE_DEFAULT_API_KEY, OPERATORS } from './signal-marketplace/seed-data';

export interface MockServerOptions {
  specialism: string;
  port: number;
  apiKey?: string;
}

export interface MockServerHandle {
  url: string;
  apiKey: string;
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
        apiKey,
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
        apiKey,
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
    default:
      throw new Error(
        `Unknown mock-server specialism: "${options.specialism}". Supported: signal-marketplace, creative-template.`
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
