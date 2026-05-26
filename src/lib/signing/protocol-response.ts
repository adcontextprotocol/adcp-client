/**
 * Unwrap the AdCP payload from a protocol-level response. Both the
 * capability-priming flow and the agent-URL-bootstrap discovery chain need
 * to peel a `get_adcp_capabilities` response back to its plain-object body
 * regardless of which transport delivered it:
 *
 *   - MCP `CallToolResult` — `structuredContent` wins when present;
 *     otherwise the first `content[].text` chunk is parsed as JSON.
 *   - A2A JSON-RPC `SendMessageResponse` — `result` is a `Task` or `Message`
 *     with latest structured DataPart data.
 *   - Already-unwrapped payload — returned as-is.
 *
 * Lives in its own module so the two callers (`capability-priming` and
 * `agent-resolver`) share one source of truth instead of forking the
 * envelope walk.
 */

import { getLatestA2ADataPartFromTask } from '../utils/a2a-artifacts';

export function unwrapProtocolResponse(response: unknown): unknown {
  if (!response || typeof response !== 'object') return response;
  const r = response as Record<string, unknown>;

  if (r.structuredContent && typeof r.structuredContent === 'object') return r.structuredContent;

  const content = r.content;
  if (Array.isArray(content)) {
    for (const chunk of content) {
      if (chunk && typeof chunk === 'object' && typeof (chunk as { text?: unknown }).text === 'string') {
        try {
          return JSON.parse((chunk as { text: string }).text);
        } catch {
          // non-JSON text chunk — keep looking
        }
      }
    }
  }

  const result = r.result;
  if (result && typeof result === 'object') {
    const artifactData = getLatestA2ADataPartFromTask(result)?.data;
    if (artifactData) {
      return artifactData;
    }

    const parts = (result as { parts?: unknown }).parts;
    const data = findLatestDataPart(parts);
    if (data) return data;
  }

  return response;
}

function findLatestDataPart(parts: unknown): unknown {
  if (!Array.isArray(parts)) return undefined;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (part && typeof part === 'object') {
      const p = part as { kind?: unknown; data?: unknown };
      if (p.kind === 'data' && p.data && typeof p.data === 'object') return p.data;
    }
  }
  return undefined;
}
