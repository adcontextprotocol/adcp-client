import { bootSignalMarketplace } from './signal-marketplace/server';
import { DEFAULT_API_KEY, OPERATORS } from './signal-marketplace/seed-data';

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
}

/**
 * Boot a mock upstream platform for the given specialism. Returns a handle
 * the caller (CLI or matrix harness) uses to read connection details and
 * shut down cleanly.
 *
 * Currently supported specialisms: `signal-marketplace`. Adding a new one
 * means adding the upstream-shape OpenAPI + seed data + boot function under
 * `src/lib/mock-server/<specialism>/` and a switch case here.
 */
export async function bootMockServer(options: MockServerOptions): Promise<MockServerHandle> {
  switch (options.specialism) {
    case 'signal-marketplace': {
      const { url, close } = await bootSignalMarketplace({
        port: options.port,
        apiKey: options.apiKey,
      });
      const apiKey = options.apiKey ?? DEFAULT_API_KEY;
      return {
        url,
        apiKey,
        close,
        summary: () => formatSignalMarketplaceSummary(url, apiKey),
      };
    }
    default:
      throw new Error(`Unknown mock-server specialism: "${options.specialism}". Supported: signal-marketplace.`);
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
