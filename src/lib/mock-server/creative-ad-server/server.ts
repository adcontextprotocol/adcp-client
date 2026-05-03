/**
 * `creative-ad-server` upstream-shape mock-server. Stateful creative
 * library (POST writes, GET reads), tag generation with macro substitution,
 * synth delivery reporting. Closes #1459 (sub-issue of #1381).
 *
 * Pattern source:
 *   - Library state shape: `sales-guaranteed/server.ts` handleCreateCreative /
 *     handleListCreatives — network-scoped, idempotency on client_request_id.
 *   - Format catalog projection: `creative-template/server.ts` (templates
 *     in seed-data, projected at request-time).
 *
 * Specialism deltas vs `creative-template`:
 *   - Stateful library (writes persist across calls).
 *   - Format auto-detection from upload mime (handleCreateCreative).
 *   - Tag generation (POST /v1/creatives/{id}/render) substitutes macros
 *     into a stored snippet template — `{click_url}`, `{impression_pixel}`,
 *     `{cb}`, `{advertiser_id}`, etc.
 *   - Real `/serve/{creative_id}` HTML response — adopters get a true
 *     iframe-embeddable URL on previewCreative, not a synthetic string.
 *   - Delivery reporting (GET /v1/creatives/{id}/delivery) — synth
 *     impressions/clicks/CTR scaled by days-active, deterministic-seeded
 *     on (creative_id, day).
 *   - Multi-tenancy via X-Network-Code header (mirrors sales-guaranteed).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import {
  CREATIVES,
  DEFAULT_API_KEY,
  FORMATS,
  NETWORKS,
  projectFormat,
  type MockCreative,
  type MockFormat,
  type MockNetwork,
} from './seed-data';

export interface BootOptions {
  port: number;
  apiKey?: string;
  networks?: MockNetwork[];
  formats?: MockFormat[];
  creatives?: MockCreative[];
}

export interface BootResult {
  url: string;
  close: () => Promise<void>;
}

interface CreativeState extends MockCreative {
  body_fingerprint: string;
}

const PAGE_SIZE_DEFAULT = 50;

export async function bootCreativeAdServer(options: BootOptions): Promise<BootResult> {
  const apiKey = options.apiKey ?? DEFAULT_API_KEY;
  const networks = options.networks ?? NETWORKS;
  const formats = options.formats ?? FORMATS;
  const seededCreatives = options.creatives ?? CREATIVES;

  const creatives = new Map<string, CreativeState>();
  for (const seed of seededCreatives) {
    creatives.set(seed.creative_id, {
      ...seed,
      body_fingerprint: sha256(JSON.stringify(seed)),
    });
  }

  // Idempotency table — keyed `<network_code>::creative::<client_request_id>`.
  const idempotency = new Map<string, string>();

  // Traffic counters keyed by `<METHOD> <route-template>`. Harness queries
  // `GET /_debug/traffic` after the storyboard run and asserts headline
  // routes were hit ≥1. Façade adapters that skip the upstream produce
  // zero counters and fail the assertion.
  const traffic = new Map<string, number>();
  const bump = (routeTemplate: string): void => {
    traffic.set(routeTemplate, (traffic.get(routeTemplate) ?? 0) + 1);
  };

  const server = createServer((req, res) => {
    handleRequest(req, res).catch(err => {
      writeJson(res, 500, { code: 'internal_error', message: err?.message ?? 'unexpected error' });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : options.port;
  const url = `http://127.0.0.1:${boundPort}`;
  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
      }),
  };

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reqUrl = new URL(req.url ?? '/', url);
    const path = reqUrl.pathname;
    const method = req.method ?? 'GET';

    // Façade-detection traffic dump — harness-only, no auth required.
    if (method === 'GET' && path === '/_debug/traffic') {
      writeJson(res, 200, { traffic: Object.fromEntries(traffic) });
      return;
    }

    // Network discovery — no auth (happens before tenant context is known).
    if (method === 'GET' && path === '/_lookup/network') {
      bump('GET /_lookup/network');
      const adcpPublisher = reqUrl.searchParams.get('adcp_publisher');
      if (!adcpPublisher) {
        writeJson(res, 400, { code: 'invalid_request', message: 'adcp_publisher query parameter is required.' });
        return;
      }
      const match = networks.find(n => n.adcp_publisher === adcpPublisher);
      if (!match) {
        writeJson(res, 404, {
          code: 'network_not_found',
          message: `No upstream network registered for adcp_publisher=${adcpPublisher}.`,
        });
        return;
      }
      writeJson(res, 200, {
        adcp_publisher: match.adcp_publisher,
        network_code: match.network_code,
        display_name: match.display_name,
      });
      return;
    }

    // /serve/{creative_id} — real HTML response. No bearer auth: this is
    // the URL real ad servers expose to publisher iframes; gating it on
    // bearer tokens would defeat the test-mode CDN-style pattern. The
    // creative_id itself is the capability — leak prevention is whoever
    // gets the URL gets the render. Production servers of course gate
    // this through signed URLs / referrer checks.
    const serveMatch = path.match(/^\/serve\/([^/]+)$/);
    if (method === 'GET' && serveMatch && serveMatch[1]) {
      bump('GET /serve/{id}');
      const creativeId = decodeURIComponent(serveMatch[1]);
      const cr = creatives.get(creativeId);
      if (!cr) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><title>Not found</title>');
        return;
      }
      const ctxParam = reqUrl.searchParams.get('ctx') ?? '';
      const html = renderServeHtml(cr, formats, url, ctxParam);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }

    // Auth gate for /v1/* surface.
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== apiKey) {
      writeJson(res, 401, { code: 'unauthorized', message: 'Missing or invalid bearer credential.' });
      return;
    }
    const networkHeader = req.headers['x-network-code'];
    const networkCode = Array.isArray(networkHeader) ? networkHeader[0] : networkHeader;
    if (!networkCode) {
      writeJson(res, 403, { code: 'network_required', message: 'X-Network-Code header is required on every request.' });
      return;
    }
    const network = networks.find(n => n.network_code === networkCode);
    if (!network) {
      writeJson(res, 403, { code: 'unknown_network', message: `Unknown network: ${networkCode}` });
      return;
    }

    if (method === 'GET' && path === '/v1/formats') {
      bump('GET /v1/formats');
      const filtered = formats.filter(f => f.network_code === network.network_code);
      writeJson(res, 200, {
        formats: filtered.map(f => ({
          format_id: f.format_id,
          name: f.name,
          channel: f.channel,
          render_kind: f.render_kind,
          ...(f.width !== undefined && { width: f.width }),
          ...(f.height !== undefined && { height: f.height }),
          ...(f.duration_seconds !== undefined && { duration_seconds: f.duration_seconds }),
          accepted_mimes: f.accepted_mimes,
        })),
      });
      return;
    }

    if (method === 'GET' && path === '/v1/creatives') {
      bump('GET /v1/creatives');
      return handleListCreatives(reqUrl, network, res);
    }

    if (method === 'POST' && path === '/v1/creatives') {
      bump('POST /v1/creatives');
      return handleCreateCreative(req, network, res);
    }

    const creativeMatch = path.match(/^\/v1\/creatives\/([^/]+)(\/.*)?$/);
    if (creativeMatch && creativeMatch[1]) {
      const creativeId = decodeURIComponent(creativeMatch[1]);
      const subPath = creativeMatch[2] ?? '/';
      const creative = creatives.get(creativeId);
      if (!creative || creative.network_code !== network.network_code) {
        writeJson(res, 404, { code: 'creative_not_found', message: `Creative ${creativeId} not found.` });
        return;
      }
      if (method === 'GET' && subPath === '/') {
        bump('GET /v1/creatives/{id}');
        writeJson(res, 200, stripFingerprint(creative));
        return;
      }
      if (method === 'PATCH' && subPath === '/') {
        bump('PATCH /v1/creatives/{id}');
        return handleUpdateCreative(req, creative, res);
      }
      if (method === 'POST' && subPath === '/render') {
        bump('POST /v1/creatives/{id}/render');
        return handleRenderCreative(req, creative, res);
      }
      if (method === 'GET' && subPath === '/delivery') {
        bump('GET /v1/creatives/{id}/delivery');
        return handleGetDelivery(reqUrl, creative, res);
      }
    }

    writeJson(res, 404, { code: 'not_found', message: `No route for ${method} ${path}` });
  }

  // ────────────────────────────────────────────────────────────
  // Creatives library
  // ────────────────────────────────────────────────────────────

  function handleListCreatives(reqUrl: URL, network: MockNetwork, res: ServerResponse): void {
    let visible = Array.from(creatives.values()).filter(c => c.network_code === network.network_code);
    const advertiserId = reqUrl.searchParams.get('advertiser_id');
    if (advertiserId) visible = visible.filter(c => c.advertiser_id === advertiserId);
    const formatId = reqUrl.searchParams.get('format_id');
    if (formatId) visible = visible.filter(c => c.format_id === formatId);
    const status = reqUrl.searchParams.get('status');
    if (status) visible = visible.filter(c => c.status === status);
    const createdAfter = reqUrl.searchParams.get('created_after');
    if (createdAfter) visible = visible.filter(c => c.created_at >= createdAfter);
    const creativeIdsParam = reqUrl.searchParams.get('creative_ids');
    if (creativeIdsParam) {
      const ids = new Set(creativeIdsParam.split(','));
      visible = visible.filter(c => ids.has(c.creative_id));
    }
    visible.sort((a, b) => a.created_at.localeCompare(b.created_at));

    // Pagination cursor — opaque base64 of the next-row created_at.
    const limit = Math.min(
      Math.max(parsePositiveNumber(reqUrl.searchParams.get('limit')) ?? PAGE_SIZE_DEFAULT, 1),
      200
    );
    const cursor = reqUrl.searchParams.get('cursor');
    let startIdx = 0;
    if (cursor) {
      try {
        const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
        startIdx = visible.findIndex(c => c.created_at > decoded);
        if (startIdx < 0) startIdx = visible.length;
      } catch {
        writeJson(res, 400, { code: 'invalid_cursor', message: 'cursor is not a valid pagination token.' });
        return;
      }
    }
    const page = visible.slice(startIdx, startIdx + limit);
    const next = visible[startIdx + limit];
    const nextCursor = next ? Buffer.from(page[page.length - 1]?.created_at ?? '', 'utf8').toString('base64url') : null;

    writeJson(res, 200, {
      creatives: page.map(stripFingerprint),
      ...(nextCursor && { next_cursor: nextCursor }),
    });
  }

  async function handleCreateCreative(req: IncomingMessage, network: MockNetwork, res: ServerResponse): Promise<void> {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const name = typeof body.name === 'string' ? body.name : null;
    const advertiserId = typeof body.advertiser_id === 'string' ? body.advertiser_id : null;
    const explicitFormatId = typeof body.format_id === 'string' ? body.format_id : null;
    const snippet = typeof body.snippet === 'string' ? body.snippet : undefined;
    const clickUrl = typeof body.click_url === 'string' ? body.click_url : undefined;
    const uploadMime = typeof body.upload_mime === 'string' ? body.upload_mime : undefined;
    const widthHint = typeof body.width === 'number' ? body.width : undefined;
    const heightHint = typeof body.height === 'number' ? body.height : undefined;
    const clientRequestId = typeof body.client_request_id === 'string' ? body.client_request_id : undefined;

    if (!name || !advertiserId) {
      writeJson(res, 400, { code: 'invalid_request', message: 'name and advertiser_id are required.' });
      return;
    }

    // Format auto-detection when format_id isn't supplied. Sniff by mime
    // type + dimensions hint. Real ad servers use richer detection
    // (binary header inspection, codec sniff for video); this is the
    // minimum to demonstrate the auto-detect surface.
    let format: MockFormat | undefined;
    if (explicitFormatId) {
      format = formats.find(f => f.format_id === explicitFormatId && f.network_code === network.network_code);
      if (!format) {
        writeJson(res, 404, {
          code: 'format_not_found',
          message: `Format ${explicitFormatId} not found on network ${network.network_code}.`,
        });
        return;
      }
    } else if (uploadMime) {
      const candidates = formats.filter(
        f => f.network_code === network.network_code && f.accepted_mimes.includes(uploadMime)
      );
      // Prefer dimension-matched fixed format when hint provided.
      if (widthHint !== undefined && heightHint !== undefined) {
        format = candidates.find(c => c.width === widthHint && c.height === heightHint);
      }
      if (!format) format = candidates[0];
      if (!format) {
        writeJson(res, 422, {
          code: 'format_auto_detect_failed',
          message: `Could not auto-detect format for upload_mime=${uploadMime}; pass an explicit format_id.`,
          field: 'format_id',
        });
        return;
      }
    } else {
      writeJson(res, 400, {
        code: 'invalid_request',
        message: 'either format_id or upload_mime is required.',
        field: 'format_id',
      });
      return;
    }

    const fingerprint = sha256(JSON.stringify({ name, advertiserId, formatId: format.format_id, snippet, clickUrl }));
    if (clientRequestId) {
      const key = `${network.network_code}::creative::${clientRequestId}`;
      const existing = idempotency.get(key);
      if (existing) {
        const existingCr = creatives.get(existing);
        if (existingCr) {
          if (existingCr.body_fingerprint !== fingerprint) {
            writeJson(res, 409, {
              code: 'idempotency_conflict',
              message: `client_request_id ${clientRequestId} previously used for a different body.`,
            });
            return;
          }
          writeJson(res, 200, { ...stripFingerprint(existingCr), replayed: true });
          return;
        }
      }
    }

    // Allow caller-supplied `creative_id` override — real ad servers
    // reject this (the platform owns the namespace), but cascade-test
    // seeders need to write under a known id so storyboard fixtures
    // can reference them by alias. Production sellers ship without this
    // override path.
    const explicitCreativeId = typeof body.creative_id === 'string' ? body.creative_id : null;
    const creativeId = explicitCreativeId ?? `cr_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();
    const cr: CreativeState = {
      creative_id: creativeId,
      network_code: network.network_code,
      advertiser_id: advertiserId,
      format_id: format.format_id,
      name,
      ...(snippet !== undefined && { snippet }),
      ...(clickUrl !== undefined && { click_url: clickUrl }),
      status: 'active',
      created_at: now,
      updated_at: now,
      body_fingerprint: fingerprint,
    };
    creatives.set(creativeId, cr);
    if (clientRequestId) {
      idempotency.set(`${network.network_code}::creative::${clientRequestId}`, creativeId);
    }
    writeJson(res, 201, stripFingerprint(cr));
  }

  async function handleUpdateCreative(req: IncomingMessage, cr: CreativeState, res: ServerResponse): Promise<void> {
    const body = await readJsonObject(req, res);
    if (!body) return;
    if (typeof body.snippet === 'string') cr.snippet = body.snippet;
    if (typeof body.click_url === 'string') cr.click_url = body.click_url;
    if (typeof body.name === 'string') cr.name = body.name;
    if (typeof body.status === 'string') {
      const allowed = ['active', 'paused', 'archived', 'rejected'];
      if (!allowed.includes(body.status)) {
        writeJson(res, 400, { code: 'invalid_status', message: `status must be one of ${allowed.join(', ')}.` });
        return;
      }
      cr.status = body.status as CreativeState['status'];
    }
    cr.updated_at = new Date().toISOString();
    cr.body_fingerprint = sha256(
      JSON.stringify({
        name: cr.name,
        advertiserId: cr.advertiser_id,
        formatId: cr.format_id,
        snippet: cr.snippet,
        clickUrl: cr.click_url,
      })
    );
    writeJson(res, 200, stripFingerprint(cr));
  }

  // ────────────────────────────────────────────────────────────
  // Tag generation — macro substitution
  // ────────────────────────────────────────────────────────────

  async function handleRenderCreative(req: IncomingMessage, cr: CreativeState, res: ServerResponse): Promise<void> {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const ctx = isObject(body.context) ? body.context : {};
    const format = formats.find(f => f.format_id === cr.format_id && f.network_code === cr.network_code);
    if (!format) {
      writeJson(res, 500, {
        code: 'format_not_found',
        message: `Creative ${cr.creative_id} references unknown format ${cr.format_id}.`,
      });
      return;
    }
    const template = cr.snippet ?? format.snippet_template;
    const substituted = substituteMacros(template, cr, format, ctx);
    const tagUrl = `${url}/serve/${encodeURIComponent(cr.creative_id)}?ctx=${encodeURIComponent(serializeCtx(ctx))}`;
    writeJson(res, 200, {
      creative_id: cr.creative_id,
      format_id: cr.format_id,
      tag_html: substituted,
      tag_url: tagUrl,
      preview_url: tagUrl,
    });
  }

  // ────────────────────────────────────────────────────────────
  // Delivery — synth impressions/clicks scaled by days-active
  // ────────────────────────────────────────────────────────────

  function handleGetDelivery(reqUrl: URL, cr: CreativeState, res: ServerResponse): void {
    const startStr = reqUrl.searchParams.get('start');
    const endStr = reqUrl.searchParams.get('end');
    const now = Date.now();
    const start = startStr ? Date.parse(startStr) : Date.parse(cr.created_at);
    const end = endStr ? Date.parse(endStr) : now;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      writeJson(res, 400, { code: 'invalid_request', message: 'start/end must be ISO 8601 with end ≥ start.' });
      return;
    }

    const format = formats.find(f => f.format_id === cr.format_id && f.network_code === cr.network_code);
    const channel = format?.channel ?? 'display';
    // Per-format CTR baselines (industry-typical):
    //   display ~0.10%, video ~1.5%, ctv ~3%, audio ~0.5%
    const ctrBaseline = channel === 'video' ? 0.015 : channel === 'ctv' ? 0.03 : channel === 'audio' ? 0.005 : 0.001;

    const days = Math.max(1, Math.ceil((end - start) / (24 * 60 * 60 * 1000)));
    const breakdown: Array<{ date: string; impressions: number; clicks: number }> = [];
    let totalImpressions = 0;
    let totalClicks = 0;
    for (let d = 0; d < days; d++) {
      const dayStart = new Date(start + d * 24 * 60 * 60 * 1000);
      const dateIso = dayStart.toISOString().slice(0, 10);
      const seedHex = sha256(`${cr.creative_id}::${dateIso}`).slice(0, 8);
      const seed = parseInt(seedHex, 16);
      // Deterministic pseudo-random impressions in [10_000, 100_000).
      const impressions = 10_000 + (seed % 90_001);
      const clicks = Math.round(impressions * ctrBaseline);
      breakdown.push({ date: dateIso, impressions, clicks });
      totalImpressions += impressions;
      totalClicks += clicks;
    }
    writeJson(res, 200, {
      creative_id: cr.creative_id,
      reporting_period: {
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
      },
      totals: {
        impressions: totalImpressions,
        clicks: totalClicks,
        ctr: totalImpressions > 0 ? totalClicks / totalImpressions : 0,
      },
      breakdown,
    });
  }
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonObject(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const text = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      writeJson(res, 400, { code: 'invalid_request', message: 'request body must be a JSON object.' });
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    writeJson(res, 400, { code: 'invalid_request', message: 'request body is not valid JSON.' });
    return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function parsePositiveNumber(s: string | null): number | undefined {
  if (s === null) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function stripFingerprint(cr: CreativeState): MockCreative {
  const { body_fingerprint: _bf, ...rest } = cr;
  void _bf;
  return rest;
}

function substituteMacros(
  template: string,
  cr: CreativeState,
  format: MockFormat,
  ctx: Record<string, unknown>
): string {
  const click = typeof ctx['click_url'] === 'string' ? ctx['click_url'] : (cr.click_url ?? 'https://example.com/click');
  const assetUrl =
    typeof ctx['asset_url'] === 'string'
      ? ctx['asset_url']
      : 'https://test-assets.adcontextprotocol.org/placeholder.jpg';
  const impressionPixel =
    typeof ctx['impression_pixel'] === 'string'
      ? ctx['impression_pixel']
      : `https://imp.example/i?cr=${encodeURIComponent(cr.creative_id)}`;
  const cb = typeof ctx['cb'] === 'string' ? ctx['cb'] : String(Date.now());
  const macros: Record<string, string> = {
    click_url: String(click),
    asset_url: String(assetUrl),
    impression_pixel: String(impressionPixel),
    cb: String(cb),
    advertiser_id: cr.advertiser_id,
    creative_id: cr.creative_id,
    width: String(format.width ?? 0),
    height: String(format.height ?? 0),
    duration_seconds: String(format.duration_seconds ?? 0),
  };
  return template.replace(/\{(\w+)\}/g, (m, key: string) => macros[key] ?? m);
}

function serializeCtx(ctx: Record<string, unknown>): string {
  // Compact deterministic serialization for the /serve URL — sorted
  // keys + JSON. Real ad servers use a binary keyed lookup; this is
  // human-debuggable for storyboard output.
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(ctx).sort()) sorted[k] = ctx[k];
  return JSON.stringify(sorted);
}

function renderServeHtml(cr: CreativeState, formats: MockFormat[], baseUrl: string, ctxRaw: string): string {
  const format = formats.find(f => f.format_id === cr.format_id && f.network_code === cr.network_code);
  let ctx: Record<string, unknown> = {};
  try {
    if (ctxRaw) ctx = JSON.parse(ctxRaw) as Record<string, unknown>;
  } catch {
    // best-effort — treat as empty ctx
  }
  const template = cr.snippet ?? format?.snippet_template ?? '';
  const body = format ? substituteMacros(template, cr, format, ctx) : template;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(cr.name)} — preview</title></head>
<body style="margin:0;padding:0">
<!-- creative_id=${escapeHtml(cr.creative_id)} format_id=${escapeHtml(cr.format_id)} served from ${escapeHtml(baseUrl)} -->
${body}
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
}

// Re-export for adapters that want to drive Format projection from the
// upstream catalog directly (rare — most adapters consume `GET /v1/formats`).
export { projectFormat };
