import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  ADVERTISERS,
  OAUTH_CLIENTS,
  REFRESH_TOKEN_TTL_SECONDS,
  type MockAdvertiser,
  type MockOAuthClient,
} from './seed-data';

export interface BootOptions {
  port: number;
  /** Override seed data. */
  advertisers?: MockAdvertiser[];
  oauthClients?: MockOAuthClient[];
  /** Force-set access-token TTL for testing the refresh path. Defaults to
   * the seed value (3600s). Set to a small number (e.g. 5) to make every
   * subsequent request require a refresh. */
  accessTokenTtlSeconds?: number;
}

export interface BootResult {
  url: string;
  close: () => Promise<void>;
}

interface IssuedAccessToken {
  access_token: string;
  refresh_token: string;
  client_id: string;
  expires_at_ms: number;
  refresh_expires_at_ms: number;
}

interface AudienceState {
  audience_id: string;
  advertiser_id: string;
  name: string;
  description?: string;
  source_type: string;
  member_count: number;
  status: 'building' | 'active' | 'expired' | 'error';
  created_at: string;
  updated_at: string;
  body_fingerprint: string;
}

interface CatalogState {
  catalog_id: string;
  advertiser_id: string;
  name: string;
  vertical: string;
  status: 'active' | 'processing' | 'error';
  item_count: number;
  body_fingerprint: string;
}

interface CreativeState {
  creative_id: string;
  advertiser_id: string;
  name: string;
  format_id: string;
  primary_text: string;
  cta_label?: string;
  landing_page_url: string;
  media_url: string;
  status: 'pending_review' | 'approved' | 'rejected' | 'archived';
  created_at: string;
  body_fingerprint: string;
}

interface PixelState {
  pixel_id: string;
  advertiser_id: string;
  name: string;
  domain?: string;
  status: 'active' | 'paused';
  events_received_24h: number;
  created_at: string;
  body_fingerprint: string;
}

export async function bootSalesSocial(options: BootOptions): Promise<BootResult> {
  const advertisers = options.advertisers ?? ADVERTISERS;
  const oauthClients = options.oauthClients ?? OAUTH_CLIENTS;
  const accessTtl = options.accessTokenTtlSeconds ?? ACCESS_TOKEN_TTL_SECONDS;

  const tokensByAccess = new Map<string, IssuedAccessToken>();
  const tokensByRefresh = new Map<string, IssuedAccessToken>();

  // Per-advertiser resource state.
  const audiences = new Map<string, AudienceState>();
  const catalogs = new Map<string, CatalogState>();
  const creatives = new Map<string, CreativeState>();
  const pixels = new Map<string, PixelState>();

  // Idempotency tables — keyed `<advertiser_id>::<resource_kind>::<client_request_id>`
  // so cross-advertiser collisions are isolated.
  const idempotency = new Map<string, string>();

  // Traffic counters keyed by `<METHOD> <route-template>`. The harness queries
  // `GET /_debug/traffic` after a storyboard run and asserts the headline
  // endpoints (custom_audience/upload, event/track, etc.) were called ≥1 time.
  // Façade adapters that never call upstream produce zero counters and fail
  // the assertion — façade detection without depending on storyboard data
  // shape. See adcontextprotocol/adcp-client#1225.
  const traffic = new Map<string, number>();
  function bump(routeTemplate: string): void {
    traffic.set(routeTemplate, (traffic.get(routeTemplate) ?? 0) + 1);
  }

  function issueTokens(client: MockOAuthClient): IssuedAccessToken {
    const now = Date.now();
    const t: IssuedAccessToken = {
      access_token: `tok_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      refresh_token: `rfr_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      client_id: client.client_id,
      expires_at_ms: now + accessTtl * 1000,
      refresh_expires_at_ms: now + REFRESH_TOKEN_TTL_SECONDS * 1000,
    };
    tokensByAccess.set(t.access_token, t);
    tokensByRefresh.set(t.refresh_token, t);
    return t;
  }

  function authenticatedClient(req: IncomingMessage): MockOAuthClient | null {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) return null;
    const accessToken = auth.slice(7);
    const issued = tokensByAccess.get(accessToken);
    if (!issued) return null;
    if (issued.expires_at_ms < Date.now()) return null;
    return oauthClients.find(c => c.client_id === issued.client_id) ?? null;
  }

  const server = createServer((req, res) => {
    handleRequest(req, res).catch(err => {
      const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
      writeJson(res, 500, {
        code: 'internal_error',
        message: err?.message ?? 'unexpected error',
        request_id: requestId,
      });
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

  // ────────────────────────────────────────────────────────────
  // Top-level request dispatcher
  // ────────────────────────────────────────────────────────────
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // Façade-detection traffic dump — harness-only, no auth required.
    // Returns per-endpoint hit counts for assertion in the matrix runner.
    if (method === 'GET' && path === '/_debug/traffic') {
      writeJson(res, 200, { traffic: Object.fromEntries(traffic) });
      return;
    }

    // OAuth token endpoint — no Bearer required.
    if (method === 'POST' && path === '/oauth/token') {
      bump('POST /oauth/token');
      return handleOauthToken(req, res);
    }

    // Discovery endpoint — replaces the hardcoded principal-mapping table
    // the harness used to inline into Claude's prompt. Adapters look up the
    // upstream advertiser_id at runtime by querying with the AdCP-side
    // identifier they receive from buyers (`account.advertiser`,
    // `account.brand.domain`, etc.). No auth required — discovery is the
    // entry point before the agent has any account context. Issue #1225.
    if (method === 'GET' && path === '/_lookup/advertiser') {
      bump('GET /_lookup/advertiser');
      const adcpAdvertiser = url.searchParams.get('adcp_advertiser');
      if (!adcpAdvertiser) {
        writeJson(res, 400, {
          code: 'invalid_request',
          message: 'adcp_advertiser query parameter is required.',
        });
        return;
      }
      const match = advertisers.find(a => a.adcp_advertiser === adcpAdvertiser);
      if (!match) {
        writeJson(res, 404, {
          code: 'advertiser_not_found',
          message: `No upstream advertiser registered for adcp_advertiser=${adcpAdvertiser}.`,
        });
        return;
      }
      writeJson(res, 200, {
        adcp_advertiser: match.adcp_advertiser,
        advertiser_id: match.advertiser_id,
        display_name: match.display_name,
      });
      return;
    }

    // Everything else requires a valid access token.
    const client = authenticatedClient(req);
    if (!client) {
      writeJson(res, 401, {
        code: 'unauthorized',
        message: 'Missing, invalid, or expired bearer token. Acquire one via POST /oauth/token.',
      });
      return;
    }

    // Path-based advertiser scoping.
    const advMatch = path.match(/^\/v1\.3\/advertiser\/([^/]+)(\/.*)?$/);
    if (!advMatch || !advMatch[1]) {
      writeJson(res, 404, { code: 'not_found', message: `No route for ${method} ${path}` });
      return;
    }
    const advertiserId = decodeURIComponent(advMatch[1]);
    const subPath = advMatch[2] ?? '/';
    const advertiser = advertisers.find(a => a.advertiser_id === advertiserId);
    if (!advertiser) {
      writeJson(res, 404, {
        code: 'advertiser_not_found',
        message: `Advertiser ${advertiserId} not found.`,
      });
      return;
    }
    if (!client.authorized_advertiser_ids.includes(advertiserId)) {
      writeJson(res, 404, {
        code: 'advertiser_not_authorized',
        message: `Advertiser ${advertiserId} not visible to this OAuth client.`,
      });
      return;
    }

    // Sub-path routing — bump traffic counters on each route hit so
    // /_debug/traffic can later report which endpoints the adapter actually
    // exercised. Façade adapters return shape-valid AdCP responses without
    // calling these endpoints; the harness's post-run check catches that.
    if (method === 'GET' && subPath === '/info') {
      bump('GET /v1.3/advertiser/{id}/info');
      return handleGetAdvertiser(advertiser, res);
    }

    // Audiences
    if (method === 'GET' && subPath === '/custom_audience/list') {
      bump('GET /v1.3/advertiser/{id}/custom_audience/list');
      return handleListAudiences(advertiser, res);
    }
    if (method === 'POST' && subPath === '/custom_audience/create') {
      bump('POST /v1.3/advertiser/{id}/custom_audience/create');
      return handleCreateAudience(req, advertiser, res);
    }
    if (method === 'POST' && subPath === '/custom_audience/upload') {
      bump('POST /v1.3/advertiser/{id}/custom_audience/upload');
      return handleUploadAudience(req, advertiser, res);
    }

    // Catalogs
    if (method === 'GET' && subPath === '/catalog/list') {
      bump('GET /v1.3/advertiser/{id}/catalog/list');
      return handleListCatalogs(advertiser, res);
    }
    if (method === 'POST' && subPath === '/catalog/create') {
      bump('POST /v1.3/advertiser/{id}/catalog/create');
      return handleCreateCatalog(req, advertiser, res);
    }
    if (method === 'POST' && subPath === '/catalog/upload') {
      bump('POST /v1.3/advertiser/{id}/catalog/upload');
      return handleUploadCatalog(req, advertiser, res);
    }

    // Creatives
    if (method === 'GET' && subPath === '/creative/list') {
      bump('GET /v1.3/advertiser/{id}/creative/list');
      return handleListCreatives(advertiser, res);
    }
    if (method === 'POST' && subPath === '/creative/create') {
      bump('POST /v1.3/advertiser/{id}/creative/create');
      return handleCreateCreative(req, advertiser, res);
    }

    // Pixels (event sources)
    if (method === 'GET' && subPath === '/pixel/list') {
      bump('GET /v1.3/advertiser/{id}/pixel/list');
      return handleListPixels(advertiser, res);
    }
    if (method === 'POST' && subPath === '/pixel/create') {
      bump('POST /v1.3/advertiser/{id}/pixel/create');
      return handleCreatePixel(req, advertiser, res);
    }

    // Conversion API
    if (method === 'POST' && subPath === '/event/track') {
      bump('POST /v1.3/advertiser/{id}/event/track');
      return handleTrackEvents(req, advertiser, res);
    }

    // Planning surface — Meta/TikTok-style delivery + reach forecasts.
    // adcontextprotocol/adcp-client#1378.
    if (method === 'POST' && subPath === '/delivery_estimate') {
      bump('POST /v1.3/advertiser/{id}/delivery_estimate');
      return handleDeliveryEstimate(req, advertiser, res);
    }
    if (method === 'POST' && subPath === '/audience_reach_estimate') {
      bump('POST /v1.3/advertiser/{id}/audience_reach_estimate');
      return handleAudienceReachEstimate(req, advertiser, res);
    }
    const lookalikeMatch = subPath.match(/^\/audience\/([^/]+)\/lookalike$/);
    if (method === 'POST' && lookalikeMatch && lookalikeMatch[1]) {
      bump('POST /v1.3/advertiser/{id}/audience/{audience_id}/lookalike');
      return handleLookalikeEstimate(req, advertiser, decodeURIComponent(lookalikeMatch[1]), res);
    }

    writeJson(res, 404, { code: 'not_found', message: `No route for ${method} ${path}` });
  }

  // ────────────────────────────────────────────────────────────
  // OAuth handler
  // ────────────────────────────────────────────────────────────
  async function handleOauthToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Record<string, string>;
    try {
      body = await readForm(req);
    } catch {
      writeJson(res, 400, { code: 'invalid_request', message: 'Body must be application/x-www-form-urlencoded.' });
      return;
    }
    const grantType = body.grant_type;
    if (grantType === 'client_credentials') {
      const client = oauthClients.find(c => c.client_id === body.client_id);
      if (!client || client.client_secret !== body.client_secret) {
        writeJson(res, 400, { code: 'invalid_client', message: 'Unknown client_id or wrong client_secret.' });
        return;
      }
      const t = issueTokens(client);
      writeJson(res, 200, {
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        token_type: 'bearer',
        expires_in: Math.max(0, Math.floor((t.expires_at_ms - Date.now()) / 1000)),
      });
      return;
    }
    if (grantType === 'refresh_token') {
      const refreshToken = body.refresh_token;
      const issued = refreshToken ? tokensByRefresh.get(refreshToken) : undefined;
      if (!issued || issued.refresh_expires_at_ms < Date.now()) {
        writeJson(res, 400, { code: 'invalid_grant', message: 'Unknown or expired refresh_token.' });
        return;
      }
      const client = oauthClients.find(c => c.client_id === issued.client_id);
      if (!client) {
        writeJson(res, 400, { code: 'invalid_grant', message: 'Refresh token references a vanished client.' });
        return;
      }
      // Rotate: invalidate old refresh, issue new pair.
      tokensByRefresh.delete(refreshToken!);
      tokensByAccess.delete(issued.access_token);
      const t = issueTokens(client);
      writeJson(res, 200, {
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        token_type: 'bearer',
        expires_in: Math.max(0, Math.floor((t.expires_at_ms - Date.now()) / 1000)),
      });
      return;
    }
    writeJson(res, 400, {
      code: 'unsupported_grant_type',
      message: `grant_type must be one of: client_credentials, refresh_token. Got: ${grantType}`,
    });
  }

  // ────────────────────────────────────────────────────────────
  // Advertiser handler
  // ────────────────────────────────────────────────────────────
  function handleGetAdvertiser(advertiser: MockAdvertiser, res: ServerResponse): void {
    writeJson(res, 200, advertiser);
  }

  // ────────────────────────────────────────────────────────────
  // Audience handlers
  // ────────────────────────────────────────────────────────────
  function handleListAudiences(advertiser: MockAdvertiser, res: ServerResponse): void {
    const list = Array.from(audiences.values()).filter(a => a.advertiser_id === advertiser.advertiser_id);
    writeJson(res, 200, { audiences: list.map(stripBodyFingerprint) });
  }

  async function handleCreateAudience(
    req: IncomingMessage,
    advertiser: MockAdvertiser,
    res: ServerResponse
  ): Promise<void> {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const { name, description, source_type, client_request_id } = body as Record<string, unknown>;
    if (typeof name !== 'string' || typeof source_type !== 'string') {
      writeJson(res, 400, { code: 'invalid_request', message: 'name and source_type are required strings.' });
      return;
    }
    const validSources = ['customer_file', 'website_traffic', 'app_activity', 'lookalike', 'engagement'];
    if (!validSources.includes(source_type)) {
      writeJson(res, 400, {
        code: 'invalid_source_type',
        message: `source_type must be one of ${validSources.join(', ')}.`,
      });
      return;
    }
    const fingerprint = JSON.stringify({ name, description, source_type });
    const replay = checkIdempotentReplay(advertiser.advertiser_id, 'audience', client_request_id, fingerprint);
    if (replay.kind === 'conflict') {
      writeJson(res, 409, { code: 'idempotency_conflict', message: replay.message });
      return;
    }
    if (replay.kind === 'replay') {
      const existing = audiences.get(replay.id);
      if (existing) {
        writeJson(res, 200, stripBodyFingerprint(existing));
        return;
      }
    }
    const id = `ca_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();
    const audience: AudienceState = {
      audience_id: id,
      advertiser_id: advertiser.advertiser_id,
      name,
      description: typeof description === 'string' ? description : undefined,
      source_type,
      member_count: 0,
      status: 'building',
      created_at: now,
      updated_at: now,
      body_fingerprint: fingerprint,
    };
    audiences.set(id, audience);
    if (typeof client_request_id === 'string' && client_request_id.length > 0) {
      idempotency.set(`${advertiser.advertiser_id}::audience::${client_request_id}`, id);
    }
    writeJson(res, 201, stripBodyFingerprint(audience));
  }

  async function handleUploadAudience(
    req: IncomingMessage,
    advertiser: MockAdvertiser,
    res: ServerResponse
  ): Promise<void> {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const { audience_id, identifier_type, members } = body as Record<string, unknown>;
    if (typeof audience_id !== 'string') {
      writeJson(res, 400, { code: 'invalid_request', message: 'audience_id is required.' });
      return;
    }
    const aud = audiences.get(audience_id);
    if (!aud || aud.advertiser_id !== advertiser.advertiser_id) {
      writeJson(res, 404, { code: 'audience_not_found', message: `Audience ${audience_id} not found.` });
      return;
    }
    const validIds = [
      'hashed_email_sha256',
      'hashed_phone_sha256',
      'hashed_email_or_phone_sha256',
      'mobile_advertising_id',
    ];
    if (typeof identifier_type !== 'string' || !validIds.includes(identifier_type)) {
      writeJson(res, 400, {
        code: 'invalid_identifier_type',
        message: `identifier_type must be one of ${validIds.join(', ')}.`,
      });
      return;
    }
    if (!Array.isArray(members) || members.length === 0) {
      writeJson(res, 400, { code: 'empty_members', message: 'members must be a non-empty array.' });
      return;
    }
    if (identifier_type.startsWith('hashed_')) {
      const hashRe = /^[0-9a-f]{64}$/;
      const malformed = members.filter(m => typeof m !== 'string' || !hashRe.test(m));
      if (malformed.length > 0) {
        // Real walled gardens reject silently per-row in batch but for the
        // test fixture we hard-fail on any malformed — adapter bugs that
        // pass raw PII or wrong-cased hex get surfaced loudly.
        writeJson(res, 400, {
          code: 'invalid_hash_format',
          message:
            `${malformed.length} member(s) are not 64-char lowercase hex. Walled gardens require ` +
            `client-side SHA-256 hashing of the lowercased trimmed identifier; uploading raw PII is rejected.`,
        });
        return;
      }
    }
    aud.member_count += members.length;
    aud.status = 'active';
    aud.updated_at = new Date().toISOString();
    writeJson(res, 202, {
      audience_id,
      status: aud.status,
      batch_size: members.length,
    });
  }

  // ────────────────────────────────────────────────────────────
  // Catalog handlers
  // ────────────────────────────────────────────────────────────
  function handleListCatalogs(advertiser: MockAdvertiser, res: ServerResponse): void {
    const list = Array.from(catalogs.values()).filter(c => c.advertiser_id === advertiser.advertiser_id);
    writeJson(res, 200, { catalogs: list.map(stripBodyFingerprint) });
  }

  async function handleCreateCatalog(
    req: IncomingMessage,
    advertiser: MockAdvertiser,
    res: ServerResponse
  ): Promise<void> {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const { name, vertical, client_request_id } = body as Record<string, unknown>;
    if (typeof name !== 'string' || typeof vertical !== 'string') {
      writeJson(res, 400, { code: 'invalid_request', message: 'name and vertical are required.' });
      return;
    }
    const fingerprint = JSON.stringify({ name, vertical });
    const replay = checkIdempotentReplay(advertiser.advertiser_id, 'catalog', client_request_id, fingerprint);
    if (replay.kind === 'conflict') {
      writeJson(res, 409, { code: 'idempotency_conflict', message: replay.message });
      return;
    }
    if (replay.kind === 'replay') {
      const existing = catalogs.get(replay.id);
      if (existing) {
        writeJson(res, 200, stripBodyFingerprint(existing));
        return;
      }
    }
    const id = `cat_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const cat: CatalogState = {
      catalog_id: id,
      advertiser_id: advertiser.advertiser_id,
      name,
      vertical,
      status: 'active',
      item_count: 0,
      body_fingerprint: fingerprint,
    };
    catalogs.set(id, cat);
    if (typeof client_request_id === 'string' && client_request_id.length > 0) {
      idempotency.set(`${advertiser.advertiser_id}::catalog::${client_request_id}`, id);
    }
    writeJson(res, 201, stripBodyFingerprint(cat));
  }

  async function handleUploadCatalog(
    req: IncomingMessage,
    advertiser: MockAdvertiser,
    res: ServerResponse
  ): Promise<void> {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const { catalog_id, items } = body as Record<string, unknown>;
    if (typeof catalog_id !== 'string') {
      writeJson(res, 400, { code: 'invalid_request', message: 'catalog_id is required.' });
      return;
    }
    const cat = catalogs.get(catalog_id);
    if (!cat || cat.advertiser_id !== advertiser.advertiser_id) {
      writeJson(res, 404, { code: 'catalog_not_found', message: `Catalog ${catalog_id} not found.` });
      return;
    }
    if (!Array.isArray(items) || items.length === 0) {
      writeJson(res, 400, { code: 'empty_items', message: 'items must be a non-empty array.' });
      return;
    }
    cat.item_count += items.length;
    writeJson(res, 202, { catalog_id, batch_size: items.length });
  }

  // ────────────────────────────────────────────────────────────
  // Creative handlers
  // ────────────────────────────────────────────────────────────
  function handleListCreatives(advertiser: MockAdvertiser, res: ServerResponse): void {
    const list = Array.from(creatives.values()).filter(c => c.advertiser_id === advertiser.advertiser_id);
    writeJson(res, 200, { creatives: list.map(stripBodyFingerprint) });
  }

  async function handleCreateCreative(
    req: IncomingMessage,
    advertiser: MockAdvertiser,
    res: ServerResponse
  ): Promise<void> {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const { name, format_id, primary_text, cta_label, landing_page_url, media_url, client_request_id } = body as Record<
      string,
      unknown
    >;
    if (
      typeof name !== 'string' ||
      typeof format_id !== 'string' ||
      typeof primary_text !== 'string' ||
      typeof landing_page_url !== 'string' ||
      typeof media_url !== 'string'
    ) {
      writeJson(res, 400, {
        code: 'invalid_request',
        message: 'name, format_id, primary_text, landing_page_url, media_url are all required strings.',
      });
      return;
    }
    const validFormats = ['native_feed', 'story_video', 'vertical_video', 'carousel_image'];
    if (!validFormats.includes(format_id)) {
      writeJson(res, 400, { code: 'invalid_format', message: `format_id must be one of ${validFormats.join(', ')}.` });
      return;
    }
    const fingerprint = JSON.stringify({ name, format_id, primary_text, cta_label, landing_page_url, media_url });
    const replay = checkIdempotentReplay(advertiser.advertiser_id, 'creative', client_request_id, fingerprint);
    if (replay.kind === 'conflict') {
      writeJson(res, 409, { code: 'idempotency_conflict', message: replay.message });
      return;
    }
    if (replay.kind === 'replay') {
      const existing = creatives.get(replay.id);
      if (existing) {
        writeJson(res, 200, stripBodyFingerprint(existing));
        return;
      }
    }
    const id = `cr_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const cr: CreativeState = {
      creative_id: id,
      advertiser_id: advertiser.advertiser_id,
      name,
      format_id,
      primary_text,
      cta_label: typeof cta_label === 'string' ? cta_label : undefined,
      landing_page_url,
      media_url,
      status: 'pending_review',
      created_at: new Date().toISOString(),
      body_fingerprint: fingerprint,
    };
    creatives.set(id, cr);
    if (typeof client_request_id === 'string' && client_request_id.length > 0) {
      idempotency.set(`${advertiser.advertiser_id}::creative::${client_request_id}`, id);
    }
    writeJson(res, 201, stripBodyFingerprint(cr));
  }

  // ────────────────────────────────────────────────────────────
  // Pixel handlers
  // ────────────────────────────────────────────────────────────
  function handleListPixels(advertiser: MockAdvertiser, res: ServerResponse): void {
    const list = Array.from(pixels.values()).filter(p => p.advertiser_id === advertiser.advertiser_id);
    writeJson(res, 200, { pixels: list.map(stripBodyFingerprint) });
  }

  async function handleCreatePixel(
    req: IncomingMessage,
    advertiser: MockAdvertiser,
    res: ServerResponse
  ): Promise<void> {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const { name, domain, client_request_id } = body as Record<string, unknown>;
    if (typeof name !== 'string') {
      writeJson(res, 400, { code: 'invalid_request', message: 'name is required.' });
      return;
    }
    const fingerprint = JSON.stringify({ name, domain });
    const replay = checkIdempotentReplay(advertiser.advertiser_id, 'pixel', client_request_id, fingerprint);
    if (replay.kind === 'conflict') {
      writeJson(res, 409, { code: 'idempotency_conflict', message: replay.message });
      return;
    }
    if (replay.kind === 'replay') {
      const existing = pixels.get(replay.id);
      if (existing) {
        writeJson(res, 200, stripBodyFingerprint(existing));
        return;
      }
    }
    const id = `px_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const px: PixelState = {
      pixel_id: id,
      advertiser_id: advertiser.advertiser_id,
      name,
      domain: typeof domain === 'string' ? domain : undefined,
      status: 'active',
      events_received_24h: 0,
      created_at: new Date().toISOString(),
      body_fingerprint: fingerprint,
    };
    pixels.set(id, px);
    if (typeof client_request_id === 'string' && client_request_id.length > 0) {
      idempotency.set(`${advertiser.advertiser_id}::pixel::${client_request_id}`, id);
    }
    writeJson(res, 201, stripBodyFingerprint(px));
  }

  // ────────────────────────────────────────────────────────────
  // Conversion API (events) handler
  // ────────────────────────────────────────────────────────────
  async function handleTrackEvents(
    req: IncomingMessage,
    advertiser: MockAdvertiser,
    res: ServerResponse
  ): Promise<void> {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const { pixel_id, events } = body as Record<string, unknown>;
    if (typeof pixel_id !== 'string') {
      writeJson(res, 400, { code: 'invalid_request', message: 'pixel_id is required.' });
      return;
    }
    const px = pixels.get(pixel_id);
    if (!px || px.advertiser_id !== advertiser.advertiser_id) {
      writeJson(res, 404, { code: 'pixel_not_found', message: `Pixel ${pixel_id} not found.` });
      return;
    }
    if (!Array.isArray(events) || events.length === 0) {
      writeJson(res, 400, { code: 'empty_events', message: 'events must be a non-empty array.' });
      return;
    }
    let received = 0;
    let dropped = 0;
    const hashRe = /^[0-9a-f]{64}$/;
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') {
        dropped++;
        continue;
      }
      const event = ev as Record<string, unknown>;
      if (typeof event.event_name !== 'string' || typeof event.event_time !== 'number') {
        dropped++;
        continue;
      }
      const userData = event.user_data as Record<string, unknown> | undefined;
      const hasMatchableId = !!(
        userData &&
        ((typeof userData.email_sha256 === 'string' && hashRe.test(userData.email_sha256)) ||
          (typeof userData.phone_sha256 === 'string' && hashRe.test(userData.phone_sha256)) ||
          (typeof userData.external_id_sha256 === 'string' && hashRe.test(userData.external_id_sha256)))
      );
      if (!hasMatchableId) {
        // Walled gardens reject events without a matchable identifier.
        dropped++;
        continue;
      }
      received++;
    }
    if (received === 0) {
      writeJson(res, 400, {
        code: 'no_matchable_events',
        message:
          `All ${events.length} events were dropped — none carried a hashed identifier ` +
          `(email_sha256, phone_sha256, or external_id_sha256). Walled-garden CAPI requires ` +
          `at least one matchable identifier per event.`,
      });
      return;
    }
    px.events_received_24h += received;
    writeJson(res, 200, { pixel_id, events_received: received, events_dropped: dropped });
  }

  // ────────────────────────────────────────────────────────────
  // Planning surface (Meta/TikTok-style forecast endpoints)
  // adcontextprotocol/adcp-client#1378
  // ────────────────────────────────────────────────────────────
  async function handleDeliveryEstimate(
    req: IncomingMessage,
    advertiser: MockAdvertiser,
    res: ServerResponse
  ): Promise<void> {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const { targeting, optimization_goal, budget, target_outcome, flight_dates } = body as Record<string, unknown>;
    if (typeof optimization_goal !== 'string') {
      writeJson(res, 400, {
        code: 'invalid_request',
        message: 'optimization_goal is required (e.g. "reach", "conversions", "clicks", "video_views").',
      });
      return;
    }
    if (budget === undefined && target_outcome === undefined) {
      writeJson(res, 400, {
        code: 'invalid_request',
        message: 'Provide either budget (forward forecast) or target_outcome (reverse / goal-based forecast).',
      });
      return;
    }
    if (budget !== undefined && (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0)) {
      writeJson(res, 400, {
        code: 'invalid_request',
        message: 'budget must be a positive number.',
      });
      return;
    }
    if (
      target_outcome !== undefined &&
      (typeof target_outcome !== 'number' || !Number.isFinite(target_outcome) || target_outcome <= 0)
    ) {
      writeJson(res, 400, {
        code: 'invalid_request',
        message: 'target_outcome must be a positive number.',
      });
      return;
    }
    const targetingKey = serializeTargeting(targeting);
    const dates = isObject(flight_dates) ? flight_dates : {};
    const estimate = synthDeliveryEstimate({
      advertiserId: advertiser.advertiser_id,
      currency: advertiser.currency,
      targeting: targetingKey,
      optimizationGoal: optimization_goal,
      budget: typeof budget === 'number' ? budget : undefined,
      targetOutcome: typeof target_outcome === 'number' ? target_outcome : undefined,
      flightStart: typeof dates.start === 'string' ? dates.start : undefined,
      flightEnd: typeof dates.end === 'string' ? dates.end : undefined,
    });
    writeJson(res, 200, estimate);
  }

  async function handleAudienceReachEstimate(
    req: IncomingMessage,
    advertiser: MockAdvertiser,
    res: ServerResponse
  ): Promise<void> {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const { targeting } = body as Record<string, unknown>;
    if (!isObject(targeting)) {
      writeJson(res, 400, {
        code: 'invalid_request',
        message: 'targeting (object) is required — geo, age, interests, custom audiences, etc.',
      });
      return;
    }
    const targetingKey = serializeTargeting(targeting);
    const estimate = synthAudienceReach({
      advertiserId: advertiser.advertiser_id,
      targeting: targetingKey,
    });
    writeJson(res, 200, estimate);
  }

  async function handleLookalikeEstimate(
    req: IncomingMessage,
    advertiser: MockAdvertiser,
    audienceId: string,
    res: ServerResponse
  ): Promise<void> {
    const body = await readJsonObject(req, res);
    if (!body) return;
    const seed = audiences.get(audienceId);
    if (!seed || seed.advertiser_id !== advertiser.advertiser_id) {
      writeJson(res, 404, {
        code: 'audience_not_found',
        message: `Seed audience ${audienceId} not found for advertiser ${advertiser.advertiser_id}.`,
      });
      return;
    }
    const { similarity_pct, country } = body as Record<string, unknown>;
    if (typeof similarity_pct !== 'number' || similarity_pct < 1 || similarity_pct > 10) {
      writeJson(res, 400, {
        code: 'invalid_request',
        message: 'similarity_pct must be a number between 1 (closest) and 10 (broadest).',
      });
      return;
    }
    if (typeof country !== 'string' || country.length === 0) {
      writeJson(res, 400, {
        code: 'invalid_request',
        message: 'country (ISO 3166-1 alpha-2) is required — lookalikes are country-scoped.',
      });
      return;
    }
    const estimate = synthLookalikeEstimate({
      advertiserId: advertiser.advertiser_id,
      seedAudienceId: audienceId,
      seedSize: seed.member_count,
      similarityPct: similarity_pct,
      country,
    });
    writeJson(res, 200, estimate);
  }

  // ────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────
  function checkIdempotentReplay(
    advertiserId: string,
    resourceKind: string,
    clientRequestId: unknown,
    fingerprint: string
  ): { kind: 'replay'; id: string } | { kind: 'conflict'; message: string } | { kind: 'fresh' } {
    if (typeof clientRequestId !== 'string' || clientRequestId.length === 0) return { kind: 'fresh' };
    const key = `${advertiserId}::${resourceKind}::${clientRequestId}`;
    const existingId = idempotency.get(key);
    if (!existingId) return { kind: 'fresh' };
    const stored = lookupResource(resourceKind, existingId);
    if (!stored) return { kind: 'fresh' };
    if (stored.body_fingerprint !== fingerprint) {
      return {
        kind: 'conflict',
        message: `client_request_id ${clientRequestId} was previously used with a different body. Use a fresh idempotency key for distinct requests.`,
      };
    }
    return { kind: 'replay', id: existingId };
  }

  function lookupResource(kind: string, id: string): { body_fingerprint: string } | undefined {
    switch (kind) {
      case 'audience':
        return audiences.get(id);
      case 'catalog':
        return catalogs.get(id);
      case 'creative':
        return creatives.get(id);
      case 'pixel':
        return pixels.get(id);
      default:
        return undefined;
    }
  }
}

function stripBodyFingerprint<T extends { body_fingerprint?: string }>(record: T): Omit<T, 'body_fingerprint'> {
  const { body_fingerprint, ...rest } = record;
  return rest;
}

function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const out: Record<string, string> = {};
      for (const pair of raw.split('&')) {
        if (!pair) continue;
        const [k, v = ''] = pair.split('=');
        if (k === undefined) continue;
        out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
      }
      resolve(out);
    });
  });
}

async function readJsonObject(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    writeJson(res, 400, { code: 'invalid_json', message: 'Request body must be valid JSON.' });
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    writeJson(res, 400, { code: 'invalid_request', message: 'Body must be a JSON object.' });
    return null;
  }
  return body as Record<string, unknown>;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
}

// ────────────────────────────────────────────────────────────
// Deterministic forecast generators (#1378)
// ────────────────────────────────────────────────────────────

interface RangeMinMax {
  min: number;
  max: number;
}
interface DeliveryEstimateResponse {
  optimization_goal: string;
  currency: string;
  forecast_range_unit: 'spend' | 'conversions' | 'reach_freq' | 'clicks';
  estimated_daily_reach: RangeMinMax;
  estimated_daily_impressions: RangeMinMax;
  estimated_daily_clicks: RangeMinMax;
  estimated_daily_conversions: RangeMinMax;
  estimated_cpm: { min: number; median: number; max: number };
  bid_recommendation: { low: number; median: number; high: number };
  daily_budget_recommendation: RangeMinMax;
  delivery_curve: Array<{
    daily_budget: number;
    estimated_daily_reach: RangeMinMax;
    estimated_daily_conversions: RangeMinMax;
  }>;
  required_budget?: RangeMinMax;
  /** When the inferred budget falls below the platform learning-phase floor
   * for the chosen optimization_goal, the platform clamps and surfaces a
   * warning. Real Meta enforces $1.05/day for impressions, $5.05/day for
   * clicks, ~$40/day for conversion campaigns; TikTok floors $20/day. The
   * mock surfaces the warning so adopters wire the path before they hit it
   * in production. */
  min_budget_warning?: { floor: number; reason: string };
  generated_at: string;
}

/** Daily-budget learning-phase floors typical of walled-garden platforms.
 * Bid_strategy and platform vary; these are mid-range defaults adopters
 * can override per-tenant. */
function dailyBudgetFloor(goal: string): number {
  switch (goal) {
    case 'reach':
    case 'awareness':
    case 'video_views':
    case 'thru_play':
      return 5;
    case 'clicks':
    case 'link_clicks':
    case 'traffic':
    case 'engagement':
    case 'follows':
    case 'profile_visits':
      return 10;
    case 'conversions':
    case 'purchase':
    case 'app_install':
      return 40;
    default:
      return 10;
  }
}

function synthDeliveryEstimate(input: {
  advertiserId: string;
  currency: string;
  targeting: string | null;
  optimizationGoal: string;
  budget?: number;
  targetOutcome?: number;
  flightStart?: string;
  flightEnd?: string;
}): DeliveryEstimateResponse {
  const seedKey = stableStringify({
    advertiserId: input.advertiserId,
    targeting: input.targeting,
    goal: input.optimizationGoal,
    flight: { start: input.flightStart, end: input.flightEnd },
  });
  const seed = seedFromString(seedKey);

  // Audience pool size derived from targeting hash. Real Marketing APIs
  // base everything on this number; we anchor here too.
  const audiencePool = 500_000 + (seed.next() % 50_000_000);
  // Saturation rate — what fraction of pool you can reach at infinite spend.
  const saturationCap = 0.55 + (seed.next() % 4001) / 10_000; // [0.55, 0.95]
  // Goal-specific CPM band.
  const cpmBase = goalCpm(input.optimizationGoal, seed);

  // Funnel parameters. CTR varies by goal: reach campaigns don't optimize
  // for clicks; clicks campaigns over-index. Conversion rate likewise.
  // Applying a single conversion rate across all goals (the prior shape)
  // produced wrong reverse-forecast budgets for non-conversion goals.
  const ctr = ctrForGoal(input.optimizationGoal, seed);
  const conversionRate = conversionRateForGoal(input.optimizationGoal, seed);

  const floor = dailyBudgetFloor(input.optimizationGoal);

  // Budget anchor. Forward: caller's budget. Reverse: derive from
  // target_outcome — but the math depends on which goal is being targeted.
  let dailyBudget = input.budget ?? 0;
  let requiredBudget: RangeMinMax | undefined;
  let preClampBudget = 0;
  if (dailyBudget === 0 && input.targetOutcome !== undefined) {
    const goal = input.optimizationGoal;
    let requiredImpressions: number;
    if (goal === 'reach' || goal === 'awareness') {
      // Reverse for reach: invert the saturating curve to find the spend
      // level that hits target_outcome unique users.
      const cap = audiencePool * saturationCap;
      const targetReach = Math.min(input.targetOutcome, cap * 0.99);
      // reach = cap × (1 − e^−impressions/cap)  ⇒  impressions = −cap × ln(1 − reach/cap)
      requiredImpressions = -cap * Math.log(1 - targetReach / cap);
    } else if (goal === 'video_views' || goal === 'thru_play') {
      // Roughly 35% completion rate at the goal level; impressions ≈ views/.35
      requiredImpressions = input.targetOutcome / 0.35;
    } else if (goal === 'clicks' || goal === 'link_clicks' || goal === 'traffic') {
      requiredImpressions = input.targetOutcome / Math.max(0.001, ctr);
    } else {
      // conversions / purchase / app_install / engagement etc.
      requiredImpressions = input.targetOutcome / Math.max(ctr * conversionRate * 8, 0.0001);
    }
    dailyBudget = (requiredImpressions / 1000) * cpmBase.median;
    preClampBudget = dailyBudget;
    if (dailyBudget < floor) dailyBudget = floor;
    requiredBudget = { min: Math.floor(dailyBudget * 0.85), max: Math.ceil(dailyBudget * 1.2) };
  }
  if (dailyBudget === 0) dailyBudget = Math.max(floor, 100);

  // Saturating-curve: reach grows fast then plateaus at saturationCap × pool.
  const reachAt = (b: number): number => {
    const impressions = (b / cpmBase.median) * 1000;
    const cap = audiencePool * saturationCap;
    const ratePer = impressions / Math.max(1, cap);
    return Math.floor(cap * (1 - Math.exp(-ratePer)));
  };

  const dailyReach = reachAt(dailyBudget);
  const dailyImpressions = Math.floor((dailyBudget / cpmBase.median) * 1000);
  const dailyClicks = Math.floor(dailyImpressions * ctr);
  const dailyConversions = Math.floor(dailyClicks * conversionRate * 8); // post-click + view-through
  const rangeUnit: DeliveryEstimateResponse['forecast_range_unit'] =
    input.targetOutcome !== undefined && input.budget === undefined
      ? input.optimizationGoal === 'clicks' ||
        input.optimizationGoal === 'link_clicks' ||
        input.optimizationGoal === 'traffic'
        ? 'clicks'
        : 'conversions' // Reach-goal reverse fits the conversions enum better than reach_freq, which is broadcast-shaped per the AdCP schema.
      : 'spend';

  const tiers = [0.5, 1.0, 1.5, 2.5, 4.0].map(m => Math.round(dailyBudget * m));
  // Tighten ranges to ±15-30% (was ±60% min / ±10% max) — real walled-garden
  // delivery_estimate ranges are ±25-35% per recent benchmarks.
  const deliveryCurve = tiers.map(t => ({
    daily_budget: t,
    estimated_daily_reach: { min: Math.floor(reachAt(t) * 0.78), max: Math.floor(reachAt(t) * 1.18) },
    estimated_daily_conversions: {
      min: Math.floor((t / cpmBase.median) * 1000 * ctr * conversionRate * 8 * 0.78),
      max: Math.floor((t / cpmBase.median) * 1000 * ctr * conversionRate * 8 * 1.22),
    },
  }));

  const minBudgetWarning =
    preClampBudget > 0 && preClampBudget < floor
      ? {
          floor,
          reason: `Inferred budget ${round2(preClampBudget)} ${input.currency}/day below platform learning-phase floor for ${input.optimizationGoal} (${floor} ${input.currency}/day); clamped.`,
        }
      : undefined;

  return {
    optimization_goal: input.optimizationGoal,
    currency: input.currency,
    forecast_range_unit: rangeUnit,
    estimated_daily_reach: { min: Math.floor(dailyReach * 0.78), max: Math.floor(dailyReach * 1.18) },
    estimated_daily_impressions: {
      min: Math.floor(dailyImpressions * 0.78),
      max: Math.floor(dailyImpressions * 1.18),
    },
    estimated_daily_clicks: { min: Math.floor(dailyClicks * 0.78), max: Math.floor(dailyClicks * 1.22) },
    estimated_daily_conversions: {
      min: Math.floor(dailyConversions * 0.75),
      max: Math.floor(dailyConversions * 1.25),
    },
    estimated_cpm: cpmBase,
    bid_recommendation: {
      low: round2(cpmBase.median * 0.75),
      median: round2(cpmBase.median),
      high: round2(cpmBase.median * 1.35),
    },
    daily_budget_recommendation: {
      min: Math.max(floor, Math.floor(dailyBudget * 0.5)),
      max: Math.ceil(dailyBudget * 2),
    },
    delivery_curve: deliveryCurve,
    ...(requiredBudget && { required_budget: requiredBudget }),
    ...(minBudgetWarning && { min_budget_warning: minBudgetWarning }),
    generated_at: '2026-04-01T00:00:00.000Z',
  };
}

function ctrForGoal(goal: string, seed: DeterministicSeed): number {
  const base = (() => {
    switch (goal) {
      case 'reach':
      case 'awareness':
        return 0.003; // 0.3% — reach campaigns don't optimize for clicks
      case 'video_views':
      case 'thru_play':
        return 0.005;
      case 'clicks':
      case 'link_clicks':
      case 'traffic':
        return 0.013; // 1.3% — performance-optimized
      case 'conversions':
      case 'purchase':
      case 'app_install':
        return 0.011;
      case 'engagement':
      case 'follows':
      case 'profile_visits':
        return 0.018; // engagement campaigns get high CTR
      default:
        return 0.008;
    }
  })();
  // ±15% wobble so storyboards stay deterministic but inputs perturb output.
  return base * (0.85 + (seed.next() % 3001) / 10_000);
}

function conversionRateForGoal(goal: string, seed: DeterministicSeed): number {
  const base = (() => {
    switch (goal) {
      case 'conversions':
      case 'purchase':
        return 0.022; // optimization toward purchase tightens funnel
      case 'app_install':
        return 0.028;
      case 'reach':
      case 'awareness':
        return 0.004; // upper-funnel — conversions are incidental
      default:
        return 0.012;
    }
  })();
  return base * (0.85 + (seed.next() % 3001) / 10_000);
}

function goalCpm(goal: string, seed: DeterministicSeed): { min: number; median: number; max: number } {
  // Approximate CPM bands typical of social Marketing APIs in 2024-2026.
  // Reach is cheaper than video (in-stream/feed video CPMs run $8-15);
  // clicks and conversions are top of the band because they buy auction
  // priority for the most contested inventory.
  // Calibrated to 2024-2026 walled-garden benchmarks: reach is cheaper than
  // video CPMs (Meta in-stream/Reels run $11-16; mock weighted toward feed
  // video). Conversions tops the band as auction priority spikes.
  const base = (() => {
    switch (goal) {
      case 'reach':
      case 'awareness':
        return 7;
      case 'video_views':
      case 'thru_play':
        return 10;
      case 'engagement':
      case 'follows':
      case 'profile_visits':
        return 6;
      case 'clicks':
      case 'link_clicks':
      case 'traffic':
        return 11;
      case 'conversions':
      case 'purchase':
      case 'app_install':
        return 18;
      default:
        return 10;
    }
  })();
  // ±15% wobble — narrower than the original ±15% min / 60% max range,
  // matching real walled-garden delivery_estimate jitter (~±10-15% on CPM
  // medians, ±50-60% on min/max bounds).
  const wobble = 0.88 + (seed.next() % 2401) / 10_000; // [0.88, 1.12]
  const median = round2(base * wobble);
  return { min: round2(median * 0.7), median, max: round2(median * 1.45) };
}

interface AudienceReachResponse {
  estimated_audience_size: RangeMinMax;
  matchable_size_at_platform: RangeMinMax;
  reach_quality: 'narrow' | 'specific' | 'broad';
  generated_at: string;
}

function synthAudienceReach(input: { advertiserId: string; targeting: string | null }): AudienceReachResponse {
  const seed = seedFromString(stableStringify({ adv: input.advertiserId, t: input.targeting, kind: 'audience_reach' }));
  // Audience pool varies dramatically by targeting tightness.
  const pool = 50_000 + (seed.next() % 80_000_000);
  const matchRate = 0.55 + (seed.next() % 3501) / 10_000; // platform match ~55–90%
  const matchable = Math.floor(pool * matchRate);
  const quality: AudienceReachResponse['reach_quality'] =
    pool < 1_000_000 ? 'narrow' : pool < 10_000_000 ? 'specific' : 'broad';
  return {
    estimated_audience_size: { min: Math.floor(pool * 0.8), max: Math.floor(pool * 1.2) },
    matchable_size_at_platform: { min: Math.floor(matchable * 0.8), max: Math.floor(matchable * 1.2) },
    reach_quality: quality,
    generated_at: '2026-04-01T00:00:00.000Z',
  };
}

interface LookalikeResponse {
  seed_audience_id: string;
  similarity_pct: number;
  country: string;
  estimated_size: RangeMinMax;
  activation_eta_hours: number;
  generated_at: string;
}

/**
 * Approximate adult-internet population by country (rough order-of-magnitude
 * for top markets; default for unmatched). Used to clamp lookalike sizing
 * so a large seed doesn't produce a lookalike larger than the country.
 * Real walled-garden APIs gate lookalikes at country-share boundaries
 * (Meta caps LAL audiences at country_pop × similarity_pct/100).
 */
function countryPopulation(country: string): number {
  // Adult-internet population estimates (mid-2020s, rounded). Numbers don't
  // need to be precise — they only anchor the lookalike sizing cap so the
  // mock doesn't produce 19M LAL audiences from 1M seeds.
  const c = country.toUpperCase();
  switch (c) {
    case 'US':
      return 260_000_000;
    case 'CA':
      return 32_000_000;
    case 'GB':
    case 'UK':
      return 55_000_000;
    case 'DE':
      return 70_000_000;
    case 'FR':
      return 55_000_000;
    case 'JP':
      return 85_000_000;
    case 'AU':
      return 22_000_000;
    case 'BR':
      return 140_000_000;
    case 'IN':
      return 625_000_000;
    case 'MX':
      return 100_000_000;
    default:
      return 25_000_000; // default for smaller markets
  }
}

function synthLookalikeEstimate(input: {
  advertiserId: string;
  seedAudienceId: string;
  seedSize: number;
  similarityPct: number;
  country: string;
}): LookalikeResponse {
  const seed = seedFromString(
    stableStringify({
      adv: input.advertiserId,
      aud: input.seedAudienceId,
      country: input.country,
      pct: input.similarityPct,
    })
  );
  const pop = countryPopulation(input.country);
  // Meta's LAL math: country_pop × (similarity_pct / 100) is the upper cap.
  // A 1% LAL in the US ≈ 2.6M; a 10% LAL ≈ 26M. We hold sizing well below the
  // cap (`cap * 0.6` × `wobble ∈ [0.85, 1.15]` → max ≈ `cap * 0.69`) so the
  // mock is conservatively realistic — real walled gardens rarely hit the
  // theoretical cap on first generation.
  const cap = Math.floor(pop * (input.similarityPct / 100));
  // Seed-driven contribution as a fallback for small seeds — never exceeds
  // the platform cap.
  const seedContribution = Math.floor(Math.max(1000, input.seedSize) * (8 + input.similarityPct * 8));
  const wobble = 0.85 + (seed.next() % 3001) / 10_000;
  const size = Math.floor(Math.min(cap * 0.6, seedContribution) * wobble);
  // ETA varies by platform: TikTok 1-6h, Meta 4-24h. Mock spans both.
  const eta = 4 + (seed.next() % 21); // 4–24h
  return {
    seed_audience_id: input.seedAudienceId,
    similarity_pct: input.similarityPct,
    country: input.country.toUpperCase(),
    estimated_size: { min: Math.floor(size * 0.85), max: Math.floor(size * 1.15) },
    activation_eta_hours: eta,
    generated_at: '2026-04-01T00:00:00.000Z',
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function serializeTargeting(t: unknown): string | null {
  if (t === null || t === undefined) return null;
  if (typeof t === 'string') return t;
  try {
    return stableStringify(t);
  } catch {
    return null;
  }
}

/**
 * Recursive deterministic JSON stringifier — sorts object keys at every
 * depth so two equivalent payloads with different key insertion orders
 * hash identically. Plain `JSON.stringify(t, keys.sort())` only sorts the
 * top level AND treats the array as a key allowlist (silently dropping
 * nested fields).
 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}

interface DeterministicSeed {
  next: () => number;
}

function seedFromString(key: string): DeterministicSeed {
  // SHA-256 → 4-byte uint32 stream. Stable across Node versions; storyboards
  // can assert exact numbers without flake.
  const digest = createHash('sha256').update(key).digest();
  let offset = 0;
  return {
    next: () => {
      if (offset + 4 > digest.length) {
        const extended = createHash('sha256').update(digest).digest();
        digest.set(extended);
        offset = 0;
      }
      const v = digest.readUInt32BE(offset);
      offset += 4;
      return v;
    },
  };
}
