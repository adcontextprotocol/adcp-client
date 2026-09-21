import type {
  McpUiResourceCsp,
  McpUiResourceMeta,
  McpUiResourcePermissions,
  McpUiToolMeta,
} from '@modelcontextprotocol/ext-apps';
import type {
  McpServer,
  ReadResourceCallback,
  RegisteredResource,
  RegisteredTool,
  ResourceMetadata,
  ToolAnnotations,
} from '@modelcontextprotocol/server';

interface McpAppToolConfig {
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: ToolAnnotations;
  _meta: McpAppToolMeta;
}

interface McpAppServerHelpers {
  RESOURCE_MIME_TYPE: 'text/html;profile=mcp-app';
  RESOURCE_URI_META_KEY: 'ui/resourceUri';
  registerAppTool(
    server: Pick<McpServer, 'registerTool'>,
    name: string,
    config: McpAppToolConfig,
    handler: (...args: never[]) => unknown
  ): RegisteredTool;
  registerAppResource(
    server: Pick<McpServer, 'registerResource'>,
    name: string,
    uri: string,
    config: ResourceMetadata,
    handler: ReadResourceCallback
  ): RegisteredResource;
}

// TypeScript's legacy `node` resolver cannot follow this package export, but
// Node 20 can load the ESM helper from CommonJS. Keep the runtime import on the
// public subpath while typing the narrow official surface used below.
const { RESOURCE_MIME_TYPE, RESOURCE_URI_META_KEY, registerAppResource, registerAppTool } =
  require('@modelcontextprotocol/ext-apps/server') as McpAppServerHelpers;

/** MIME type required by the stable MCP Apps HTML resource contract. */
export const MCP_APP_RESOURCE_MIME_TYPE = RESOURCE_MIME_TYPE;

/** Content Security Policy sources requested by an MCP App resource. */
export type McpAppResourceCsp = McpUiResourceCsp;

/** Browser permissions an MCP App may ask its host to grant. */
export type McpAppResourcePermissions = McpUiResourcePermissions;

/** Security and presentation hints for an MCP App resource. */
export type McpAppResourceUiMeta = McpUiResourceMeta;

/** Typed metadata emitted on both resource discovery and resource content. */
export interface McpAppResourceMeta {
  ui?: McpAppResourceUiMeta;
}

/** Portable MCP Apps tool metadata, including the deprecated host key. */
export interface McpAppToolMeta {
  ui?: McpUiToolMeta;
  [RESOURCE_URI_META_KEY]?: string;
}

/** Transport-neutral context passed to an MCP App resource handler. */
export interface McpAppResourceReadContext {
  signal: AbortSignal;
}

/**
 * Declarative registration for one static HTML MCP App resource.
 *
 * The framework registers the resource on both the legacy MCP SDK server and
 * every modern per-request server reconstruction. The handler returns the
 * complete HTML document; the framework owns the URI, MIME type, and metadata
 * in the `resources/read` response so discovery and readback cannot drift.
 */
export interface AdcpMcpResourceDefinition {
  /** Stable programmatic name surfaced by `resources/list`. */
  name: string;
  /** MCP Apps require the `ui://` URI scheme. */
  uri: `ui://${string}`;
  title?: string;
  description?: string;
  /** Defaults to the only MIME type currently supported by MCP Apps. */
  mimeType?: typeof MCP_APP_RESOURCE_MIME_TYPE;
  _meta?: McpAppResourceMeta;
  handler: (uri: URL, ctx: McpAppResourceReadContext) => string | Promise<string>;
}

/** @internal */
export function normalizeMcpAppResources(
  resources: readonly AdcpMcpResourceDefinition[] | undefined
): readonly AdcpMcpResourceDefinition[] {
  if (resources === undefined) return [];

  const names = new Set<string>();
  const uris = new Set<string>();
  return resources.map((resource, index) => {
    const path = `resources[${index}]`;
    if (!resource || typeof resource !== 'object') {
      throw new Error(`createAdcpServer: ${path} must be an MCP App resource definition`);
    }
    if (typeof resource.name !== 'string' || resource.name.trim() === '') {
      throw new Error(`createAdcpServer: ${path}.name must be a non-empty string`);
    }
    if (names.has(resource.name)) {
      throw new Error(`createAdcpServer: duplicate MCP App resource name "${resource.name}"`);
    }
    names.add(resource.name);

    if (typeof resource.uri !== 'string' || !resource.uri.startsWith('ui://')) {
      throw new Error(`createAdcpServer: ${path}.uri must use the ui:// scheme`);
    }
    try {
      const parsed = new URL(resource.uri);
      if (parsed.protocol !== 'ui:' || (parsed.hostname === '' && parsed.pathname === '')) throw new Error('empty URI');
      if (parsed.href !== resource.uri) {
        throw new Error(`non-canonical URI; use "${parsed.href}"`);
      }
    } catch (error) {
      const detail =
        error instanceof Error && error.message.startsWith('non-canonical URI') ? ` (${error.message})` : '';
      throw new Error(`createAdcpServer: ${path}.uri must be a valid canonical ui:// URI${detail}`);
    }
    if (uris.has(resource.uri)) {
      throw new Error(`createAdcpServer: duplicate MCP App resource URI "${resource.uri}"`);
    }
    uris.add(resource.uri);

    if (resource.mimeType !== undefined && resource.mimeType !== MCP_APP_RESOURCE_MIME_TYPE) {
      throw new Error(
        `createAdcpServer: ${path}.mimeType must be "${MCP_APP_RESOURCE_MIME_TYPE}" for an MCP App resource`
      );
    }
    if (typeof resource.handler !== 'function') {
      throw new Error(`createAdcpServer: ${path}.handler must be a function`);
    }

    return { ...resource, mimeType: MCP_APP_RESOURCE_MIME_TYPE };
  });
}

/** @internal */
export function mcpAppResourceMetadata(resource: AdcpMcpResourceDefinition): Record<string, unknown> {
  return {
    ...(resource.title !== undefined && { title: resource.title }),
    ...(resource.description !== undefined && { description: resource.description }),
    ...(resource._meta !== undefined && { _meta: resource._meta }),
  };
}

/** @internal */
export function mcpAppResourceUri(meta: Record<string, unknown> | undefined): string | undefined {
  const ui = meta?.ui;
  const nested = ui !== null && typeof ui === 'object' ? (ui as Record<string, unknown>).resourceUri : undefined;
  if (typeof nested === 'string') return nested;
  const legacy = meta?.[RESOURCE_URI_META_KEY];
  return typeof legacy === 'string' ? legacy : undefined;
}

/** @internal */
export function isMcpAppToolMeta(meta: Record<string, unknown> | undefined): boolean {
  if (meta === undefined) return false;
  const ui = meta.ui;
  return (ui !== null && typeof ui === 'object') || Object.hasOwn(meta, RESOURCE_URI_META_KEY);
}

/** @internal */
export function registerMcpAppTool(
  server: Pick<McpServer, 'registerTool'>,
  name: string,
  config: McpAppToolConfig,
  handler: (...args: never[]) => unknown
): RegisteredTool {
  return registerAppTool(server, name, config, handler);
}

/** @internal */
export function registerMcpAppResource(
  server: Pick<McpServer, 'registerResource'>,
  resource: AdcpMcpResourceDefinition,
  handler: ReadResourceCallback
): RegisteredResource {
  return registerAppResource(server, resource.name, resource.uri, mcpAppResourceMetadata(resource), handler);
}

/** @internal */
export async function readMcpAppResource(
  resource: AdcpMcpResourceDefinition,
  uri: URL,
  ctx: McpAppResourceReadContext
): Promise<{
  contents: Array<{
    uri: string;
    mimeType: typeof MCP_APP_RESOURCE_MIME_TYPE;
    text: string;
    _meta?: Record<string, unknown>;
  }>;
}> {
  let text: string;
  try {
    const result = await resource.handler(uri, ctx);
    if (typeof result !== 'string') {
      throw new TypeError(`handler returned ${result === null ? 'null' : typeof result}, not a string`);
    }
    text = result;
  } catch (error) {
    // Resource callbacks sit outside the AdCP tool-error envelope. Log the
    // private cause here, then expose a fixed message so provider errors,
    // file paths, and credentials never become JSON-RPC error text.
    console.error(`[adcp/mcp-app] resource handler "${resource.name}" failed`, error);
    throw new Error('MCP App resource is temporarily unavailable');
  }
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: MCP_APP_RESOURCE_MIME_TYPE,
        text,
        ...(resource._meta !== undefined && { _meta: resource._meta as Record<string, unknown> }),
      },
    ],
  };
}
