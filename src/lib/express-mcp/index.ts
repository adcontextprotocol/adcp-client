/**
 * Express middleware that normalizes the `Accept` header so requests reach
 * `StreamableHTTPServerTransport` without tripping its 406 check.
 *
 * The MCP SDK's POST handler requires both `application/json` and
 * `text/event-stream` in `Accept` even when constructed with
 * `enableJsonResponse: true` (pure request/response mode — no SSE in play).
 * Buyer agents and validators that send `Accept: application/json` hit a
 * 406 Not Acceptable.
 *
 * This middleware rewrites `Accept: application/json` (JSON alone) to
 * `application/json, text/event-stream` on the incoming request, so the
 * transport's strict check passes. Headers that already advertise both,
 * or don't advertise JSON, are left alone.
 *
 * Mount BEFORE the MCP transport handler:
 *
 * ```ts
 * import express from 'express';
 * import { mcpAcceptHeaderMiddleware } from '@adcp/client/express-mcp';
 *
 * const app = express();
 * app.use('/mcp', mcpAcceptHeaderMiddleware());
 * // then mount the MCP transport (StreamableHTTPServerTransport.handleRequest)
 * ```
 *
 * This is a local escape hatch pending upstream SDK fix
 * (https://github.com/modelcontextprotocol/typescript-sdk/issues/1944).
 * Remove once the SDK loosens the Accept check for `enableJsonResponse: true`.
 */

import type { IncomingMessage, ServerResponse } from 'http';

/** Minimal next callback shape — avoids a dependency on `@types/express`. */
type NextFn = (err?: unknown) => void;

/** Minimal Express-compatible handler signature. */
export type McpAcceptHeaderHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  next: NextFn,
) => void;

const JSON_TYPE = 'application/json';
const SSE_TYPE = 'text/event-stream';

/**
 * Does the raw `Accept` value advertise `type`? Case-insensitive, tolerant
 * of parameters (`application/json;q=0.9`) and surrounding whitespace.
 */
function acceptsType(accept: string, type: string): boolean {
  const lower = accept.toLowerCase();
  const target = type.toLowerCase();
  for (const raw of lower.split(',')) {
    const mediaType = raw.split(';')[0]?.trim();
    if (mediaType === target) return true;
  }
  return false;
}

/**
 * Create the middleware. No options today; exported as a factory for
 * symmetry with Express convention and future extensibility.
 */
export function mcpAcceptHeaderMiddleware(): McpAcceptHeaderHandler {
  return function mcpAcceptHeader(req, _res, next) {
    const accept = req.headers.accept;

    // No Accept header at all — leave it to the SDK to handle however it does.
    if (typeof accept !== 'string' || accept.length === 0) {
      next();
      return;
    }

    const hasJson = acceptsType(accept, JSON_TYPE);
    const hasSse = acceptsType(accept, SSE_TYPE);

    // Only rewrite the JSON-only case. If the request already advertises
    // both, or doesn't advertise JSON at all (e.g. `*/*`, a stray
    // `text/plain`, or a malformed value), leave the header untouched and
    // let the transport decide.
    if (hasJson && !hasSse) {
      req.headers.accept = `${JSON_TYPE}, ${SSE_TYPE}`;
    }

    next();
  };
}
