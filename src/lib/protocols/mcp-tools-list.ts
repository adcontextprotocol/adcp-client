/**
 * Paginated MCP `tools/list` reads for the SDK's legacy (`@modelcontextprotocol/sdk`)
 * client, whose `listTools()` returns a single page.
 *
 * AdCP asks sellers to paginate the tool catalog and requires clients that need
 * all of it to follow `nextCursor` until it is absent. Capability discovery
 * needs all of it: an agent whose `get_adcp_capabilities` sits on a later page
 * would otherwise read as not supporting AdCP 3 (adcp-client#3717). The modern
 * client follows pages itself.
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
 * pages throws, since the catalog would be incomplete.
 */
export async function forEachMcpToolsPage(
  fetchPage: McpToolsPageFetcher,
  onPage: (tools: McpListedTool[]) => boolean | void
): Promise<void> {
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 1; ; page++) {
    const result = await fetchPage(cursor);
    if (onPage(result.tools) === true) return;
    const next = result.nextCursor;
    if (typeof next !== 'string' || next === '' || seenCursors.has(next)) return;
    if (page >= MAX_TOOLS_LIST_PAGES) {
      throw new Error(
        `tools/list did not finish within ${MAX_TOOLS_LIST_PAGES} pages; the tool catalog is incomplete.`
      );
    }
    seenCursors.add(next);
    cursor = next;
  }
}

/** Read the complete tool catalog. A tool name repeated on a later page keeps its first definition. */
export async function listAllMcpTools(fetchPage: McpToolsPageFetcher): Promise<McpListedTool[]> {
  const tools = new Map<string, McpListedTool>();
  await forEachMcpToolsPage(fetchPage, page => {
    for (const tool of page) if (!tools.has(tool.name)) tools.set(tool.name, tool);
  });
  return [...tools.values()];
}

/** Request params for one page: the caller's base params plus the page cursor. */
export function toolsListPageParams<P extends Record<string, unknown>>(
  params: P | undefined,
  cursor: string | undefined
): (P & { cursor?: string }) | undefined {
  return cursor === undefined ? params : ({ ...params, cursor } as P & { cursor: string });
}
