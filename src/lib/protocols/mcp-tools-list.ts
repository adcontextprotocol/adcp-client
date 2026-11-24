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
 * before. Paging through `listTools()` would leave it describing one page, and
 * a partial page set mid-read; {@link listMcpToolCatalog} keeps it whole.
 */

import type { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';

/** Page limit for one catalog read; matches the modern MCP client's default `listMaxPages`. */
export const MAX_TOOLS_LIST_PAGES = 64;

type ListToolsResult = Awaited<ReturnType<MCPClient['listTools']>>;
type ListToolsParams = Parameters<MCPClient['listTools']>[0];
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

/** Every tool across `fetchPage`'s pages; a name repeated on a later page keeps its first definition. */
export async function listAllMcpTools(
  fetchPage: McpToolsPageFetcher
): Promise<{ tools: McpListedTool[]; pages: number }> {
  const tools = new Map<string, McpListedTool>();
  const pages = await forEachMcpToolsPage(fetchPage, page => {
    for (const tool of page) if (!tools.has(tool.name)) tools.set(tool.name, tool);
  });
  return { tools: [...tools.values()], pages };
}

/** A complete catalog read from a legacy client. */
export interface McpToolCatalog {
  tools: McpListedTool[];
  /** Whether the client's cached tool metadata now covers every tool in `tools`. */
  metadataCached: boolean;
}

/**
 * Read a legacy client's complete tool catalog and leave its tool-metadata
 * cache covering the whole catalog, as a single-page server would.
 *
 * Pages are fetched with `request()`, which leaves the cache alone, and the
 * catalog is committed once it is complete. A call made during the read, or
 * after a read that failed, keeps the previous complete metadata. That commit
 * goes through the private method `listTools()` itself uses; without it,
 * page 1 goes through `listTools()`, so the cache holds page 1 as it did
 * before pagination was followed, and `metadataCached` is false for a
 * multi-page catalog. `wrapPage` wraps each page fetch, e.g. in a per-page
 * response-size allowance.
 */
export async function listMcpToolCatalog(
  client: Pick<MCPClient, 'listTools' | 'request'>,
  params: ListToolsParams,
  options: RequestOptions | undefined,
  wrapPage: <T>(fetch: () => Promise<T>) => Promise<T> = fetch => fetch()
): Promise<McpToolCatalog> {
  const commit = (client as { cacheToolMetadata?: unknown }).cacheToolMetadata;
  const { tools, pages } = await listAllMcpTools(cursor =>
    wrapPage(() => {
      const pageParams = toolsListPageParams(params, cursor);
      return typeof commit !== 'function' && cursor === undefined
        ? client.listTools(pageParams, options)
        : client.request({ method: 'tools/list', params: pageParams }, ListToolsResultSchema, options);
    })
  );
  if (typeof commit !== 'function') return { tools, metadataCached: pages === 1 };
  commit.call(client, tools);
  return { tools, metadataCached: true };
}

/** Request params for one page: the caller's base params plus the page cursor. */
export function toolsListPageParams(params: ListToolsParams, cursor: string | undefined): ListToolsParams {
  return cursor === undefined ? params : { ...params, cursor };
}
