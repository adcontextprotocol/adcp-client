/* eslint-disable @typescript-eslint/no-unused-vars */
// Type-only tests for the AdcpServer brand. The brand makes the type
// nominal — structurally-similar plain objects must NOT be assignable to
// AdcpServer because they lack the phantom symbol property.
//
// Run with `npm run typecheck`.

import type { AdcpServer } from './adcp-server';
import type { AdcpCustomToolConfig, McpAppMeta, MediaBuyHandlers } from './create-adcp-server';
import type { AdcpMcpResourceDefinition, McpAppResourceMeta } from './mcp-app';

// ── Plain object with same structural shape isn't an AdcpServer ──────────

interface PlainImitation {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dispatchTestRequest(request: unknown): Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke(options: unknown): Promise<any>;
}

declare const _imitation: PlainImitation;

function _imitationCannotBeAdcpServer(): AdcpServer {
  // @ts-expect-error — PlainImitation lacks the phantom brand symbol.
  return _imitation;
}

// ── (server as AdcpServer).registerTool isn't on the public surface ─────

declare const _server: AdcpServer;

function _registerToolNotOnAdcpServer(): void {
  // @ts-expect-error — registerTool is intentionally not exposed by AdcpServer.
  _server.registerTool('foo', {}, async () => ({ content: [] }));
}

// ── A typed AdcpServer can pass through normal SDK call sites ───────────

async function _adcpServerCallSitesStillWork(s: AdcpServer): Promise<void> {
  await s.close();
  await s.dispatchTestRequest({
    method: 'tools/call',
    params: { name: 'get_adcp_capabilities', arguments: {} },
  });
}

function _legacy_media_buy_handlers_accept_payload_returns(): MediaBuyHandlers {
  return {
    getProducts: async () => ({ products: [], cache_scope: 'account' }),
    getMediaBuys: async () => ({ media_buys: [] }),
    getMediaBuyDelivery: async () => ({
      reporting_period: { start: '2026-01-01', end: '2026-01-31' },
      media_buy_deliveries: [],
    }),
  };
}

// ── MCP App metadata is strict and portable ─────────────────────────────

const _validMcpAppMeta: McpAppMeta = {
  ui: { resourceUri: 'ui://creative/upload', visibility: ['model', 'app'] },
};

const _customToolWithMcpAppMeta: AdcpCustomToolConfig = {
  _meta: _validMcpAppMeta,
  handler: async () => ({ content: [] }),
};

const _invalidMcpAppMeta: McpAppMeta = {
  ui: {
    // @ts-expect-error — only model and app are supported visibility values.
    visibility: ['server'],
  },
};

const _flatMcpAppMeta: McpAppMeta = {
  // @ts-expect-error — MCP App metadata uses the nested ui.resourceUri shape.
  'ui.resourceUri': 'ui://creative/upload',
};

const _validMcpAppResourceMeta: McpAppResourceMeta = {
  ui: {
    csp: {
      connectDomains: ['https://api.example.com'],
      resourceDomains: ['https://cdn.example.com'],
      frameDomains: ['https://player.example.com'],
      baseUriDomains: ['https://cdn.example.com'],
    },
    domain: 'upload.example.com',
    prefersBorder: true,
  },
};

const _validMcpAppResource: AdcpMcpResourceDefinition = {
  name: 'creative_upload',
  uri: 'ui://creative/upload',
  mimeType: 'text/html;profile=mcp-app',
  _meta: _validMcpAppResourceMeta,
  handler: async (_uri, { signal }) => (signal.aborted ? '' : '<!doctype html><html></html>'),
};

const _invalidMcpAppResourceUri: AdcpMcpResourceDefinition = {
  name: 'wrong_scheme',
  // @ts-expect-error — MCP App resources require the ui:// scheme.
  uri: 'https://example.com/app',
  handler: async () => '<!doctype html><html></html>',
};

const _invalidMcpAppResourceMime: AdcpMcpResourceDefinition = {
  name: 'wrong_mime',
  uri: 'ui://creative/wrong-mime',
  // @ts-expect-error — arbitrary HTML MIME types are not MCP App resources.
  mimeType: 'text/html',
  handler: async () => '<!doctype html><html></html>',
};

export const _references = [
  _imitationCannotBeAdcpServer,
  _registerToolNotOnAdcpServer,
  _adcpServerCallSitesStillWork,
  _legacy_media_buy_handlers_accept_payload_returns,
  _validMcpAppMeta,
  _customToolWithMcpAppMeta,
  _invalidMcpAppMeta,
  _flatMcpAppMeta,
  _validMcpAppResourceMeta,
  _validMcpAppResource,
  _invalidMcpAppResourceUri,
  _invalidMcpAppResourceMime,
] as const;
