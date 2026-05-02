import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
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
