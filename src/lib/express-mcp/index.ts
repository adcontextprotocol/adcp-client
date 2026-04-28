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
 * The rewrite touches BOTH `req.headers.accept` AND the matching entries in
 * `req.rawHeaders`. `StreamableHTTPServerTransport.handleRequest` runs the
 * incoming `IncomingMessage` through `@hono/node-server`'s
 * `newHeadersFromIncoming`, which rebuilds the Fetch `Headers` from
 * `rawHeaders` and ignores `req.headers`. Patching only the parsed map
 * leaves the transport reading the original unmodified value and the 406
 * still fires — the pair has to move together.
 *
 * **Edge case, intentionally NOT auto-synthesized:** if `req.headers.accept`
 * exists but `req.rawHeaders` has no Accept entry (some reverse proxies
 * mutate `req.headers` without rebuilding `rawHeaders`), the middleware
 * still patches `req.headers.accept` but leaves `rawHeaders` as-is. The
 * transport then sees no Accept at all on the `rawHeaders` rebuild and
 * falls through to its missing-Accept path. Adding a phantom `['Accept',
 * '…']` pair would diverge `req.rawHeaders` from the wire-level headers
 * and can confuse other middleware (RFC 9421 verifiers, request-signing
 * canonicalizers) that use `rawHeaders` as authoritative. If you hit
 * this divergence in practice, fix the upstream proxy — don't monkey-
 * patch here.
 *
 * Mount BEFORE the MCP transport handler:
 *
 * ```ts
 * import express from 'express';
 * import { mcpAcceptHeaderMiddleware } from '@adcp/sdk/express-mcp';
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
export type McpAcceptHeaderHandler = (req: IncomingMessage, res: ServerResponse, next: NextFn) => void;

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
      const rewritten = `${JSON_TYPE}, ${SSE_TYPE}`;
      req.headers.accept = rewritten;
      rewriteRawAcceptHeader(req, rewritten);
    }

    next();
  };
}

/**
 * Rewrite every `Accept` entry in `req.rawHeaders` to `rewritten`.
 *
 * `rawHeaders` is a flat `[name, value, name, value, ...]` array where
 * header names preserve the wire-level casing. The scan is case-insensitive
 * so `Accept` / `ACCEPT` / `accept` all match. Duplicates (rare, but
 * allowed by HTTP) are ALL rewritten so a later copy can't shadow the
 * patched one. If the header is absent we don't append — adding it here
 * would diverge from the pre-middleware request shape and could surprise
 * other middleware that reads `rawHeaders` directly.
 */
function rewriteRawAcceptHeader(req: IncomingMessage, rewritten: string): void {
  const raw = (req as { rawHeaders?: unknown }).rawHeaders;
  if (!Array.isArray(raw)) return;
  for (let i = 0; i < raw.length - 1; i += 2) {
    const name = raw[i];
    if (typeof name === 'string' && name.toLowerCase() === 'accept') {
      raw[i + 1] = rewritten;
    }
  }
}
