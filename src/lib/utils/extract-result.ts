/**
 * Extract structured data from an MCP `CallToolResult`.
 *
 * AdCP servers put the typed tool response in `structuredContent` (MCP L3);
 * `content[0].text` carries a human-readable summary (MCP L2). Prefer
 * `structuredContent` when present, fall back to JSON-parsing a text block
 * for servers that haven't adopted `structuredContent` yet.
 *
 * **Returns `undefined`** when neither surface yields usable data. This
 * is the ergonomic happy-path helper — the companion
 * `unwrapProtocolResponse` **throws** on missing/invalid payloads and
 * additionally validates against a per-tool schema, handling protocol
 * detection and extraction-path provenance. Pick based on the caller:
 *
 * - `extractResult<T>(res)` — "I just want the payload; `undefined` if
 *   there's nothing to extract." No throw, no validation.
 * - `unwrapProtocolResponse(res, toolName, 'mcp')` — "Give me a
 *   validated, schema-narrowed AdCP response or throw." Heavier, tool-aware.
 *
 * `content[]` entries that aren't text blocks (image / audio / resource
 * per the MCP `CallToolResult.content` schema) are intentionally
 * skipped — AdCP's typed payload always rides on `structuredContent`
 * or the first JSON-parseable text block.
 *
 * @example
 * ```ts
 * import { extractResult } from '@adcp/client';
 *
 * const res = await mcpClient.callTool({ name: 'get_products', arguments: {} });
 * const payload = extractResult<GetProductsResponse>(res);
 * if (payload && 'products' in payload) {
 *   // payload is the Success arm — narrow further if it's a Success|Error union
 * }
 * ```
 */
export interface ToolCallResultLike {
  structuredContent?: unknown;
  content?: Array<{ type?: string; text?: string } | null | undefined>;
  isError?: boolean;
}

export function extractResult<T = unknown>(result: ToolCallResultLike | null | undefined): T | undefined {
  if (result == null || typeof result !== 'object') return undefined;

  const structured = result.structuredContent;
  if (structured != null && typeof structured === 'object') {
    return structured as T;
  }

  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      // Non-text blocks (image/audio/resource) carry no AdCP payload —
      // skip silently rather than throwing on an unknown block type.
      if (block && block.type === 'text' && typeof block.text === 'string') {
        try {
          return JSON.parse(block.text) as T;
        } catch {
          // Not JSON — keep scanning for another text block.
        }
      }
    }
  }

  return undefined;
}
