/**
 * Paginated MCP `tools/list` reads for the SDK's legacy (`@modelcontextprotocol/sdk`)
 * client, whose `listTools()` returns a single page.
 *
 * AdCP asks sellers to paginate the tool catalog and requires clients that need
 * all of it to follow `nextCursor` until it is absent. Capability discovery
 * needs all of it: an agent whose `get_adcp_capabilities` sits on a later page
 * would otherwise read as not supporting AdCP 3 (adcp-client#3717). The modern
 * client follows pages itself.
 *
 * The legacy client also caches per-tool metadata (output-schema validators,
 * task support) from each `listTools()` result, replacing what it cached
 * before. After a multi-page read it would describe only the last page, so the
 * catalog read here puts the whole catalog back into that cache.
 */

import type { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';

/** Page limit for one catalog read; matches the modern MCP client's default `listMaxPages`. */
export const MAX_TOOLS_LIST_PAGES = 64;

type ListToolsResult = Awaited<ReturnType<MCPClient['listTools']>>;
export type McpListedTool = ListToolsResult['tools'][number];

/** Fetch one page. `cursor` is undefined for the first page. */
export type McpToolsPageFetcher = (cursor: string | undefined) => Promise<ListToolsResult>;

/**
 * Visit `tools/list` pages in order until the server stops paginating or
 * `onPage` returns `true`. A cursor the server already returned ends the read,
 * as the `list_accounts` loop does; more than {@link MAX_TOOLS_LIST_PAGES}
 * pages throws, since the catalog would be incomplete. Returns the number of
 * pages read.
 */
export async function forEachMcpToolsPage(
  fetchPage: McpToolsPageFetcher,
  onPage: (tools: McpListedTool[]) => boolean | void
): Promise<number> {
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 1; ; page++) {
    const result = await fetchPage(cursor);
    if (onPage(result.tools) === true) return page;
    const next = result.nextCursor;
    if (typeof next !== 'string' || next === '' || seenCursors.has(next)) return page;
    if (page >= MAX_TOOLS_LIST_PAGES) {
      throw new Error(
        `tools/list did not finish within ${MAX_TOOLS_LIST_PAGES} pages; the tool catalog is incomplete.`
      );
    }
    seenCursors.add(next);
    cursor = next;
  }
}

/** A complete catalog read. */
export interface McpToolCatalog {
  /** Every tool; a name repeated on a later page keeps its first definition. */
  tools: McpListedTool[];
  /** Whether `client`'s cached tool metadata now covers every tool in `tools`. */
  metadataCached: boolean;
}

/**
 * Read the complete tool catalog. When the catalog spans several pages and
 * `client` is the legacy client the pages came from, its tool-metadata cache
 * is reset to the whole catalog, as a single-page server would have left it.
 */
export async function listAllMcpTools(fetchPage: McpToolsPageFetcher, client?: object): Promise<McpToolCatalog> {
  const tools = new Map<string, McpListedTool>();
  const pages = await forEachMcpToolsPage(fetchPage, page => {
    for (const tool of page) if (!tools.has(tool.name)) tools.set(tool.name, tool);
  });
  const catalog = [...tools.values()];
  const metadataCached = pages === 1 || (client !== undefined && cacheMcpToolMetadata(client, catalog));
  return { tools: catalog, metadataCached };
}

/**
 * Reset a legacy client's cached tool metadata to `tools`, through the same
 * private method its `listTools()` uses. Returns `false`, changing nothing,
 * when the installed SDK has no such method.
 */
function cacheMcpToolMetadata(client: object, tools: McpListedTool[]): boolean {
  const cache = (client as { cacheToolMetadata?: unknown }).cacheToolMetadata;
  if (typeof cache !== 'function') return false;
  cache.call(client, tools);
  return true;
}

/** Request params for one page: the caller's base params plus the page cursor. */
export function toolsListPageParams<P extends Record<string, unknown>>(
  params: P | undefined,
  cursor: string | undefined
): (P & { cursor?: string }) | undefined {
  return cursor === undefined ? params : ({ ...params, cursor } as P & { cursor: string });
}
