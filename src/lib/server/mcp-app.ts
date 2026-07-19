/** MIME type required by the stable MCP Apps HTML resource contract. */
export const MCP_APP_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app' as const;

/** Content Security Policy sources requested by an MCP App resource. */
export interface McpAppResourceCsp {
  /** Origins allowed for fetch, XHR, and WebSocket connections. */
  connectDomains?: string[];
  /** Origins allowed for scripts, styles, images, fonts, and media. */
  resourceDomains?: string[];
  /** Origins allowed for nested iframes. */
  frameDomains?: string[];
  /** Origins allowed in the document's base URI. */
  baseUriDomains?: string[];
}

/** Browser permissions an MCP App may ask its host to grant. */
export interface McpAppResourcePermissions {
  camera?: Record<string, never>;
  microphone?: Record<string, never>;
  geolocation?: Record<string, never>;
  clipboardWrite?: Record<string, never>;
}

/** Security and presentation hints for an MCP App resource. */
export interface McpAppResourceUiMeta {
  csp?: McpAppResourceCsp;
  permissions?: McpAppResourcePermissions;
  /** Host-specific dedicated sandbox domain. */
  domain?: string;
  /** Whether the host should render a visible boundary around the app. */
  prefersBorder?: boolean;
}

/** Typed metadata emitted on both resource discovery and resource content. */
export interface McpAppResourceMeta {
  ui?: McpAppResourceUiMeta;
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
    mimeType: MCP_APP_RESOURCE_MIME_TYPE,
    ...(resource._meta !== undefined && { _meta: resource._meta }),
  };
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
