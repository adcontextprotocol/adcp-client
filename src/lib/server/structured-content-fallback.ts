import type { McpToolResponse } from './responses';

/** Marker placed on SDK-generated structured-content compatibility blocks. */
export const ADCP_MIRRORED_STRUCTURED_CONTENT_META_KEY = 'adcp/mirrored-structured-content';

/** Transport applying the final response decoration. */
export type StructuredContentFallbackTransport = 'mcp' | 'a2a' | 'direct';

/**
 * Client/session information available when deciding whether to mirror an MCP
 * structured result into text.
 *
 * The objects deliberately remain structurally loose. MCP can add capability
 * and implementation fields without requiring an AdCP SDK release first.
 */
export interface StructuredContentTextFallbackContext {
  transport: StructuredContentFallbackTransport;
  clientInfo?: Readonly<{ name: string; version: string; [key: string]: unknown }>;
  clientCapabilities?: Readonly<Record<string, unknown>>;
}

/**
 * Controls the MCP structured-content text fallback.
 *
 * `auto` currently degrades to `always`: MCP has no standardized client
 * capability declaring that structured tool results reach the model. It is a
 * named migration point for capability negotiation once MCP adds one. A
 * predicate is consulted only when client identity is known (or for A2A,
 * where transport alone is meaningful); unknown MCP/direct clients mirror as
 * a fail-safe.
 */
export type StructuredContentTextFallback =
  | 'always'
  | 'never'
  | 'auto'
  | ((context: StructuredContentTextFallbackContext) => boolean);

function shouldMirrorStructuredContent(
  policy: StructuredContentTextFallback,
  context: StructuredContentTextFallbackContext
): boolean {
  if (typeof policy === 'function') {
    // A missing MCP/direct client identity is a legitimate embedding path, not
    // evidence that the caller consumes structured results. Keep it legible.
    // A2A is the exception: transport is sufficient context for a predicate to
    // suppress its redundant internal mirror.
    if (context.transport !== 'a2a' && context.clientInfo === undefined) return true;
    try {
      const decision = policy(context);
      return typeof decision === 'boolean' ? decision : context.transport !== 'a2a';
    } catch {
      // A compatibility hint must not make the canonical result illegible.
      return context.transport !== 'a2a';
    }
  }
  if (policy === 'never') return false;
  // A2A artifacts carry the typed result in a DataPart. The MCP text fallback
  // has no wire role there, so named/default policies keep A2A responses clean.
  if (context.transport === 'a2a') return false;
  // `auto` intentionally shares today's fail-safe `always` behavior until a
  // standardized structured-content consumption capability exists.
  return true;
}

/**
 * Decorate a canonical tool response at the transport edge.
 *
 * Returns a shallow copy when it appends the fallback so framework/idempotency
 * cache objects are never mutated. Existing exact compact-JSON text blocks are
 * retained as-is; structural/pretty-print deduplication would require parsing
 * adopter-authored prose and is intentionally out of scope.
 */
export function applyStructuredContentTextFallback<T>(
  value: T,
  policy: StructuredContentTextFallback,
  context: StructuredContentTextFallbackContext
): T {
  if (!shouldMirrorStructuredContent(policy, context)) return value;
  if (value == null || typeof value !== 'object') return value;

  const response = value as Partial<McpToolResponse>;
  if (response.structuredContent === undefined || !Array.isArray(response.content)) return value;

  const serialized = JSON.stringify(response.structuredContent);
  if (serialized === undefined) return value;
  if (response.content.some(block => block.type === 'text' && block.text === serialized)) return value;

  return {
    ...(value as object),
    content: [
      ...response.content,
      {
        type: 'text',
        text: serialized,
        _meta: { [ADCP_MIRRORED_STRUCTURED_CONTENT_META_KEY]: true },
      },
    ],
  } as T;
}
