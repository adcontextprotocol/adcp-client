/**
 * hello_seller_adapter_social — worked starting point for an
 * AdCP sales agent (specialism `sales-social`) that wraps an upstream
 * walled-garden social-platform API via OAuth2 client_credentials.
 *
 * Fork this. Replace `upstream` with calls to your real backend. The
 * AdCP-facing platform methods stay the same.
 *
 * FORK CHECKLIST
 *   1. Replace every `// SWAP:` marker with calls to your backend.
 *   2. Replace `KNOWN_ADVERTISERS` (line ~271) with your tenant directory.
 *   3. Replace `audience_targeting` and `conversion_tracking` capability
 *      declarations with the identifier types / event types your platform
 *      actually accepts.
 *   4. Replace the `m.uids[i]` → `external_id_sha256` projection in
 *      `logEvent` with your CAPI's specific UID-to-field mapping.
 *   5. Replace `eventSourceMap` with persistent storage (DB / cache).
 *   6. Validate: `node --test test/examples/hello-seller-adapter-social.test.js`
 *
 * Demo:
 *   npx @adcp/sdk@latest mock-server sales-social --port 4350
 *   UPSTREAM_URL=http://127.0.0.1:4350 \
 *     UPSTREAM_OAUTH_CLIENT_ID=walled_garden_test_client_001 \
 *     UPSTREAM_OAUTH_CLIENT_SECRET=walled_garden_test_secret_do_not_use_in_prod \
 *     npx tsx examples/hello_seller_adapter_social.ts
 *   adcp storyboard run http://127.0.0.1:3003/mcp sales_social \
 *     --auth sk_harness_do_not_use_in_prod
 *   curl http://127.0.0.1:4350/_debug/traffic
 */

import {
  createAdcpServerFromPlatform,
  serve,
  verifyApiKey,
  createIdempotencyStore,
  createUpstreamHttpClient,
  memoryBackend,
  AdcpError,
  defineSalesPlatform,
  defineAudiencePlatform,
  type DecisioningPlatform,
  type SalesPlatform,
  type AudiencePlatform,
  type AccountStore,
  type Account,
  type SyncAudiencesRow,
  type SyncCreativesRow,
  type SyncAccountsResultRow,
} from '@adcp/sdk/server';
import type {
  SyncCatalogsSuccess,
  LogEventSuccess,
  SyncEventSourcesSuccess,
  GetAccountFinancialsSuccess,
} from '@adcp/sdk/types';

const UPSTREAM_URL = process.env['UPSTREAM_URL'] ?? 'http://127.0.0.1:4350';
const UPSTREAM_CLIENT_ID = process.env['UPSTREAM_OAUTH_CLIENT_ID'] ?? 'walled_garden_test_client_001';
const UPSTREAM_CLIENT_SECRET =
  process.env['UPSTREAM_OAUTH_CLIENT_SECRET'] ?? 'walled_garden_test_secret_do_not_use_in_prod';
const PORT = Number(process.env['PORT'] ?? 3003);
const ADCP_AUTH_TOKEN = process.env['ADCP_AUTH_TOKEN'] ?? 'sk_harness_do_not_use_in_prod';

// ---------------------------------------------------------------------------
// OAuth token cache — SWAP for production.
// Real platforms vary; some require per-advertiser tokens, some support
// per-app + advertiser-impersonation. Mock issues a single token valid for
// every authorized advertiser. The `dynamic_bearer.getToken` hook below is
// the swap point — substitute your platform's token-acquisition flow.
// ---------------------------------------------------------------------------

interface TokenCache {
  access_token: string;
  expires_at_ms: number;
}
let tokenCache: TokenCache | null = null;

async function fetchOauthToken(): Promise<TokenCache> {
  // SWAP: production OAuth token flow. Mock issues client_credentials grants
  // via POST /oauth/token (form-urlencoded). Real walled-garden CAPIs vary
  // in path (`/oauth/access_token`, `/oauth2/access_token`) and refresh
  // rotation; the upstream client below abstracts that away.
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: UPSTREAM_CLIENT_ID,
    client_secret: UPSTREAM_CLIENT_SECRET,
  });
  const res = await fetch(`${UPSTREAM_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new AdcpError('SERVICE_UNAVAILABLE', {
      message: `Upstream OAuth token endpoint returned ${res.status}: ${text.slice(0, 200)}`,
    });
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  return {
    access_token: json.access_token,
    expires_at_ms: Date.now() + json.expires_in * 1000 - 5000, // refresh 5s early
  };
}

async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expires_at_ms) return tokenCache.access_token;
  tokenCache = await fetchOauthToken();
  return tokenCache.access_token;
}

const http = createUpstreamHttpClient({
  baseUrl: UPSTREAM_URL,
  auth: { kind: 'dynamic_bearer', getToken: () => getAccessToken() },
});

// ---------------------------------------------------------------------------
// Upstream client — SWAP for production.
// Each method below maps one AdCP tool to one upstream call. Replace the
// fetch path + body shape; the typed AdCP-facing handlers below stay the same.
// ---------------------------------------------------------------------------

// The mock's /_lookup/advertiser endpoint returns only the trio
// `{adcp_advertiser, advertiser_id, display_name}` — no currency/timezone.
// /v1.3/advertiser/{id}/info returns the richer record with currency,
// timezone, and status. Production platforms vary in which discovery
// endpoint carries which field; the lesson is to read each field from
// the endpoint that actually returns it.
interface UpstreamAdvertiserLookup {
  advertiser_id: string;
  display_name: string;
  adcp_advertiser: string;
}
interface UpstreamAdvertiserInfo {
  advertiser_id: string;
  display_name: string;
  adcp_advertiser: string;
  currency: string;
  timezone: string;
  status: 'active' | 'suspended' | 'archived';
}

const upstream = {
  // SWAP: tenant lookup by AdCP-side identifier.
  async lookupAdvertiser(advertiserDomain: string): Promise<UpstreamAdvertiserLookup | null> {
    const { body } = await http.get<UpstreamAdvertiserLookup>('/_lookup/advertiser', {
      adcp_advertiser: advertiserDomain,
    });
    return body;
  },

  // SWAP: GET advertiser financial info. Mock returns spend/cap/payment.
  async getAdvertiserInfo(advertiserId: string): Promise<UpstreamAdvertiserInfo | null> {
    const { body } = await http.get<UpstreamAdvertiserInfo>(
      `/v1.3/advertiser/${encodeURIComponent(advertiserId)}/info`
    );
    return body;
  },

  // SWAP: audience creation + member upload. Real platforms split this two
  // ways: a metadata create, then a hashed-member upload — the standard
  // walled-garden custom-audience two-step flow.
  async createAudience(
    advertiserId: string,
    a: { audience_id: string; name: string; description?: string }
  ): Promise<{ audience_id: string; status: string }> {
    const r = await http.post<{ audience_id: string; status: string }>(
      `/v1.3/advertiser/${encodeURIComponent(advertiserId)}/custom_audience/create`,
      a
    );
    if (r.body === null) {
      throw new AdcpError('INVALID_REQUEST', { message: 'audience creation rejected by upstream' });
    }
    return r.body;
  },
  async uploadAudienceMembers(
    advertiserId: string,
    body: { audience_id: string; member_count: number }
  ): Promise<void> {
    await http.post(`/v1.3/advertiser/${encodeURIComponent(advertiserId)}/custom_audience/upload`, body);
  },

  // SWAP: audience reach estimate. Real Meta `/{ad-account-id}/reachestimate`,
  // TikTok `/v1.3/tool/audience_reach_estimate/`, Snap `/forecast`. The mock
  // returns deterministic ranges keyed on (advertiser_id, targeting), so the
  // numbers are stable across runs but vary observably with targeting.
  // Surface this on AdCP wire as `SyncAudiencesRow.matched_count` /
  // `effective_match_rate` (per `/schemas/3.0.5/core/audience.json`).
  async audienceReachEstimate(
    advertiserId: string,
    body: { targeting: Record<string, unknown> }
  ): Promise<{
    estimated_audience_size: { min: number; max: number };
    matchable_size_at_platform: { min: number; max: number };
    reach_quality: 'narrow' | 'specific' | 'broad';
  } | null> {
    const r = await http.post<{
      estimated_audience_size: { min: number; max: number };
      matchable_size_at_platform: { min: number; max: number };
      reach_quality: 'narrow' | 'specific' | 'broad';
    }>(`/v1.3/advertiser/${encodeURIComponent(advertiserId)}/audience_reach_estimate`, body);
    return r.body;
  },

  // SWAP: catalog create + items upload. Same two-step pattern as audiences.
  async createCatalog(
    advertiserId: string,
    c: { catalog_id: string; name: string; vertical: string }
  ): Promise<{ catalog_id: string; status: string }> {
    const r = await http.post<{ catalog_id: string; status: string }>(
      `/v1.3/advertiser/${encodeURIComponent(advertiserId)}/catalog/create`,
      c
    );
    if (r.body === null) {
      throw new AdcpError('INVALID_REQUEST', { message: 'catalog creation rejected by upstream' });
    }
    return r.body;
  },
  async uploadCatalogItems(advertiserId: string, body: { catalog_id: string; items: unknown[] }): Promise<void> {
    await http.post(`/v1.3/advertiser/${encodeURIComponent(advertiserId)}/catalog/upload`, body);
  },

  // SWAP: native creative create.
  async createCreative(
    advertiserId: string,
    c: {
      creative_id: string;
      name: string;
      format_id: string;
      primary_text: string;
      cta_label?: string;
      landing_page_url: string;
      media_url: string;
    }
  ): Promise<{ creative_id: string; status: string }> {
    const r = await http.post<{ creative_id: string; status: string }>(
      `/v1.3/advertiser/${encodeURIComponent(advertiserId)}/creative/create`,
      c
    );
    if (r.body === null) {
      throw new AdcpError('INVALID_REQUEST', { message: 'creative creation rejected by upstream' });
    }
    return r.body;
  },

  // SWAP: pixel (event source) registration.
  async createPixel(
    advertiserId: string,
    p: { pixel_id: string; name: string; domain?: string }
  ): Promise<{ pixel_id: string }> {
    const r = await http.post<{ pixel_id: string }>(
      `/v1.3/advertiser/${encodeURIComponent(advertiserId)}/pixel/create`,
      p
    );
    if (r.body === null) {
      throw new AdcpError('INVALID_REQUEST', { message: 'pixel creation rejected by upstream' });
    }
    return r.body;
  },

  // SWAP: conversions API (event/track). Mock body shape mirrors the
  // walled-garden CAPI conventions:
  // events[i] needs event_name, event_time (UNIX seconds), user_data with at
  // least one hashed identifier (email_sha256, phone_sha256, external_id_sha256).
  // Production platforms vary in field names but the matchable-id requirement
  // is universal across walled gardens.
  async trackEvents(
    advertiserId: string,
    body: {
      pixel_id: string;
      events: Array<{
        event_name: string;
        event_time: number;
        user_data: { external_id_sha256?: string; email_sha256?: string; phone_sha256?: string };
      }>;
    }
  ): Promise<{ events_received: number; events_dropped: number }> {
    const r = await http.post<{ pixel_id: string; events_received: number; events_dropped: number }>(
      `/v1.3/advertiser/${encodeURIComponent(advertiserId)}/event/track`,
      body
    );
    if (r.body === null) {
      throw new AdcpError('INVALID_REQUEST', { message: 'event tracking rejected by upstream' });
    }
    return { events_received: r.body.events_received, events_dropped: r.body.events_dropped };
  },
};

// ---------------------------------------------------------------------------
// AdCP-side adapter — typed against SalesPlatform + AudiencePlatform.
// ---------------------------------------------------------------------------

interface AdvertiserMeta {
  /** Resolved upstream advertiser_id, cached on the Account by accounts.resolve. */
  advertiser_id: string;
  advertiser_domain: string;
  [key: string]: unknown;
}

// Known advertiser fan-out for `list_accounts`. Real platforms expose a
// /v1.3/advertiser/list endpoint scoped to the OAuth client; the mock
// requires the adapter to know the set up-front, so we inline the well-known
// AdCP-side identifiers from the mock's seed data. SWAP: replace with a
// real `/advertiser/list` call.
const KNOWN_ADVERTISERS = ['acmeoutdoor.example', 'summit-media.example'];

// Buyer event_source_id → upstream pixel_id translation map. The mock
// ignores buyer-supplied pixel_id and assigns its own (`px_<uuid>`); buyers
// reference their own id in subsequent log_event calls. We record the
// mapping at create time and resolve at log time. Production: replace with
// your DB / cache. The SDK's `createTranslationMap` helper formalizes this
// bidirectional pattern when you outgrow the in-memory map.
const eventSourceMap = new Map<string, string>(); // (advertiser_id, buyer_id) → upstream_pixel_id
function eventSourceKey(advertiserId: string, buyerEventSourceId: string): string {
  return `${advertiserId}::${buyerEventSourceId}`;
}

// Asset readers — narrow on the asset_type discriminator before reading the
// typed sub-shape's `content` / `url` field. A bare cast loses the
// discriminator narrowing and silently picks up the wrong field on the wrong
// asset variant. See skills/SHAPE-GOTCHAS.md. AssetVariant isn't re-exported
// from `@adcp/sdk/types` (#1254 in the adapter ergonomics rollup), so we type
// the helper input as `unknown` and narrow inline.
function readContent(asset: unknown): string | undefined {
  if (!asset || typeof asset !== 'object') return undefined;
  const a = asset as { asset_type?: string; content?: string };
  if (a.asset_type === 'text' || a.asset_type === 'html' || a.asset_type === 'markdown') {
    return a.content;
  }
  return undefined;
}
function readUrl(asset: unknown): string | undefined {
  if (!asset || typeof asset !== 'object') return undefined;
  const a = asset as { asset_type?: string; url?: string };
  if (a.asset_type === 'url' || a.asset_type === 'image' || a.asset_type === 'video') {
    return a.url;
  }
  return undefined;
}

class SalesSocialAdapter implements DecisioningPlatform<Record<string, never>, AdvertiserMeta> {
  capabilities = {
    specialisms: ['sales-social'] as const,
    // Media-buy specialisms require channels + pricingModels even when the
    // adapter doesn't actually sell media buys (the storyboard exercises
    // sync_audiences / sync_creatives, not create_media_buy). Declare the
    // shape that matches what the platform would accept if a buy came in.
    channels: ['social'] as const,
    pricingModels: ['cpm'] as const,
    // Required for sync_audiences phase to be applicable — projected onto
    // `media_buy.audience_targeting` on get_adcp_capabilities. Without it
    // the storyboard runner skips the audience phase as not_applicable.
    audience_targeting: {
      supported_identifier_types: ['hashed_email' as const, 'hashed_phone' as const],
      minimum_audience_size: 100,
    },
    // Required for sync_event_sources / log_event phases — projected onto
    // `media_buy.conversion_tracking`. Mock pixel surface accepts these
    // event types; production maps to the platform's actual conversion API.
    conversion_tracking: {
      supported_event_types: ['purchase' as const, 'add_to_cart' as const, 'page_view' as const, 'lead' as const],
      supported_action_sources: ['website' as const, 'app' as const],
    },
    config: {},
  };

  accounts: AccountStore<AdvertiserMeta> = {
    /** Translate AdCP `account.brand.domain` → upstream `advertiser_id`.
     *  The mock's discovery endpoint is /_lookup/advertiser; production
     *  varies (some platforms expose /advertisers, some require a
     *  per-principal lookup). For no-account tools (`provide_performance_feedback`,
     *  `list_creative_formats`), `ref` is undefined; we don't model those. */
    resolve: async ref => {
      // No-account tool branch (`log_event` / `provide_performance_feedback`
      // / `list_creative_formats` — wire request omits `account`). Framework
      // calls resolve(undefined); we fall through to the first known
      // advertiser so ctx.account is non-null at runtime.
      // SWAP: production should derive the advertiser from `ctx.authInfo`
      // (per-OAuth-client tenant binding) or from a request-body lookup
      // (e.g., `event_source_id` → advertiser mapping persisted at sync time).
      // Returning the first known advertiser is a single-tenant convenience.
      let advertiserDomain: string | undefined;
      let operator: string | undefined;
      if (ref === undefined) {
        advertiserDomain = KNOWN_ADVERTISERS[0];
      } else if ('account_id' in ref) {
        // SWAP: production keeps an account_id → upstream-advertiser-id index
        // populated during `sync_accounts`/`list_accounts`. The mock lacks
        // this surface so the account_id arm is unreachable in the worked
        // example; real adapters add a directory lookup here.
        return null;
      } else {
        advertiserDomain = ref.brand.domain;
        operator = ref.operator;
      }
      if (!advertiserDomain) return null;
      const upstreamAdv = await upstream.lookupAdvertiser(advertiserDomain);
      if (!upstreamAdv) return null;
      return {
        id: upstreamAdv.advertiser_id,
        name: upstreamAdv.display_name,
        status: 'active',
        ...(operator !== undefined && { operator }),
        brand: { domain: upstreamAdv.adcp_advertiser },
        ctx_metadata: {
          advertiser_id: upstreamAdv.advertiser_id,
          advertiser_domain: upstreamAdv.adcp_advertiser,
        },
      };
    },

    /** list_accounts handler. Iterate known advertisers, lookup each one,
     *  and return the cursor page. */
    list: async () => {
      const items: Array<Account<AdvertiserMeta>> = [];
      for (const domain of KNOWN_ADVERTISERS) {
        const adv = await upstream.lookupAdvertiser(domain);
        if (!adv) continue;
        items.push({
          id: adv.advertiser_id,
          name: adv.display_name,
          status: 'active',
          brand: { domain: adv.adcp_advertiser },
          ctx_metadata: {
            advertiser_id: adv.advertiser_id,
            advertiser_domain: adv.adcp_advertiser,
          },
        });
      }
      return { items, has_more: false };
    },

    /** sync_accounts handler. Social platforms typically pre-provision
     *  advertiser seats out-of-band — this is a discovery/echo, not a
     *  provisioning call. Per the storyboard, list_accounts is the
     *  canonical alternative (declared via `provides_state_for`). */
    upsert: async refs => {
      const out: SyncAccountsResultRow[] = [];
      for (const ref of refs) {
        // sync_accounts always carries the brand+operator arm (the buyer is
        // registering an account, not referencing an existing one). The
        // account_id arm of AccountReference is invalid input here per the
        // wire schema — but tolerate it defensively via the discriminator.
        if ('account_id' in ref) {
          out.push({
            brand: { domain: '' },
            operator: '',
            action: 'failed',
            status: 'rejected',
            errors: [{ code: 'INVALID_REQUEST', message: 'sync_accounts requires brand+operator, not account_id' }],
          });
          continue;
        }
        const domain = ref.brand.domain;
        const operator = ref.operator;
        if (!domain) {
          out.push({
            brand: { domain: '' },
            operator,
            action: 'failed',
            status: 'rejected',
            errors: [{ code: 'INVALID_REQUEST', message: 'brand.domain required' }],
          });
          continue;
        }
        const adv = await upstream.lookupAdvertiser(domain);
        if (!adv) {
          out.push({
            brand: { domain },
            operator,
            action: 'failed',
            status: 'rejected',
            errors: [{ code: 'ACCOUNT_NOT_FOUND', message: `No advertiser registered for ${domain}` }],
          });
          continue;
        }
        out.push({
          account_id: adv.advertiser_id,
          name: adv.display_name,
          brand: { domain: adv.adcp_advertiser },
          operator,
          action: 'unchanged',
          status: 'active',
        });
      }
      return out;
    },

    getAccountFinancials: async (req): Promise<GetAccountFinancialsSuccess> => {
      const acct = req.account;
      // AccountReference discriminated union. account_id arm requires the
      // production directory lookup the mock doesn't model — see SWAP note
      // on `accounts.resolve` above.
      if ('account_id' in acct) {
        throw new AdcpError('ACCOUNT_NOT_FOUND', {
          message: 'account_id lookup not modeled in this worked example — see SWAP markers on accounts.resolve',
          field: 'account.account_id',
        });
      }
      const domain = acct.brand.domain;
      const operator = acct.operator;
      const adv = await upstream.lookupAdvertiser(domain);
      if (!adv) throw new AdcpError('ACCOUNT_NOT_FOUND', { message: `No advertiser for ${domain}` });
      const info = await upstream.getAdvertiserInfo(adv.advertiser_id);
      if (!info) throw new AdcpError('ACCOUNT_NOT_FOUND', { message: `No info for ${adv.advertiser_id}` });
      const today = new Date().toISOString().slice(0, 10);
      // currency + timezone live on /info, not /_lookup. The mock's /info
      // doesn't carry spend; production does. Synthesize total_spend: 0 for
      // the example — adopters should plug their billing system here.
      return {
        account: { brand: { domain: info.adcp_advertiser }, operator },
        currency: info.currency,
        period: { start: today, end: today },
        timezone: info.timezone,
        spend: { total_spend: 0 },
      };
    },
  };

  audiences: AudiencePlatform<AdvertiserMeta> = defineAudiencePlatform<AdvertiserMeta>({
    syncAudiences: async (audiences, ctx): Promise<SyncAudiencesRow[]> => {
      const advertiserId = ctx.account.ctx_metadata.advertiser_id;
      const rows: SyncAudiencesRow[] = [];
      for (const a of audiences) {
        try {
          const created = await upstream.createAudience(advertiserId, {
            audience_id: a.audience_id ?? '',
            name: a.name ?? a.audience_id ?? 'audience',
            ...(a.description !== undefined && { description: a.description }),
          });
          // Two-step pattern — create then upload. Mock's body shape is
          // contrived (member_count int instead of hashed members); production
          // sends actual hashed identifiers.
          await upstream.uploadAudienceMembers(advertiserId, {
            audience_id: created.audience_id,
            member_count: 0,
          });
          // Pull a reach estimate so the buyer-facing row can surface
          // `matched_count` / `effective_match_rate` per the spec. Real
          // walled-garden APIs return reach numbers asynchronously after
          // upload; mock returns synchronously for demo purposes. The mock
          // endpoint hashes targeting → deterministic ranges, so we synthesize
          // a per-audience targeting from the audience_id (production passes
          // the actual targeting definition the buyer sent).
          const reach = await upstream.audienceReachEstimate(advertiserId, {
            targeting: { audience_seed: created.audience_id },
          });
          const matched = reach?.matchable_size_at_platform
            ? Math.floor((reach.matchable_size_at_platform.min + reach.matchable_size_at_platform.max) / 2)
            : undefined;
          const total = reach?.estimated_audience_size
            ? Math.floor((reach.estimated_audience_size.min + reach.estimated_audience_size.max) / 2)
            : undefined;
          rows.push({
            audience_id: a.audience_id ?? created.audience_id,
            name: a.name ?? created.audience_id,
            seller_id: created.audience_id,
            action: 'created',
            // AudienceStatus enum is 'processing' | 'ready' | 'too_small' —
            // 'matching' isn't a wire value. Mock returns its custom 'building'
            // status which projects to 'processing' on AdCP wire.
            status: 'processing',
            ...(matched !== undefined && { matched_count: matched }),
            ...(matched !== undefined && total !== undefined && total > 0 && { effective_match_rate: matched / total }),
          });
        } catch (err) {
          rows.push({
            audience_id: a.audience_id ?? '',
            ...(a.name !== undefined && { name: a.name }),
            action: 'failed',
            errors: [
              {
                code: err instanceof AdcpError ? err.code : 'INVALID_REQUEST',
                message: err instanceof Error ? err.message : 'audience sync failed',
              },
            ],
          });
        }
      }
      return rows;
    },

    /** Stub — the storyboard's audience phase doesn't call this, but the
     *  AudiencePlatform interface requires it. Production maps to a
     *  /v1.3/advertiser/{id}/custom_audience/list call. */
    pollAudienceStatuses: async () => new Map(),
  });

  // Walled-garden platforms own bidding internally — the buyer flow is
  // sync_audiences / sync_creatives / log_event, not create_media_buy.
  // SalesPlatform's core methods (getProducts/createMediaBuy/updateMediaBuy/
  // getMediaBuyDelivery/getMediaBuys) are now optional; RequiredPlatformsFor
  // <'sales-social'> requires only SalesIngestionPlatform. Implementing just
  // the ingestion surface keeps the example honest and lets buyers calling
  // unsupported tools get METHOD_NOT_FOUND from the dispatcher rather than
  // an UNSUPPORTED_FEATURE thrown from a stub.
  sales: SalesPlatform<AdvertiserMeta> = defineSalesPlatform<AdvertiserMeta>({
    syncCreatives: async (creatives, ctx): Promise<SyncCreativesRow[]> => {
      const advertiserId = ctx.account.ctx_metadata.advertiser_id;
      const rows: SyncCreativesRow[] = [];
      for (const c of creatives) {
        try {
          // Project AdCP `CreativeAsset.assets` (the asset map keyed by
          // asset_id) onto the upstream native creative shape. Asset values
          // carry an `asset_type` discriminator; we read the typed sub-shapes
          // by narrowing on `asset_type`. Mock accepts a flat
          // `primary_text` / `landing_page_url` / `media_url`; production
          // platforms vary in field names but the shape is similar.
          const assets = c.assets;
          const primaryText = readContent(assets['headline']) ?? readContent(assets['primary_text']) ?? c.name;
          const landingPageUrl =
            readUrl(assets['click_url']) ?? readUrl(assets['landing_page']) ?? 'https://example.com';
          const mediaUrl = readUrl(assets['image']) ?? readUrl(assets['video']) ?? 'https://example.com/asset';

          const created = await upstream.createCreative(advertiserId, {
            creative_id: c.creative_id,
            name: c.name,
            format_id: c.format_id.id,
            primary_text: primaryText,
            landing_page_url: landingPageUrl,
            media_url: mediaUrl,
          });
          rows.push({
            creative_id: c.creative_id,
            action: 'created',
            status: created.status === 'approved' ? 'approved' : 'pending_review',
            platform_id: created.creative_id,
          });
        } catch (err) {
          rows.push({
            creative_id: c.creative_id,
            action: 'failed',
            errors: [
              {
                code: err instanceof AdcpError ? err.code : 'INVALID_REQUEST',
                message: err instanceof Error ? err.message : 'creative sync failed',
              },
            ],
          });
        }
      }
      return rows;
    },

    syncCatalogs: async (req, ctx): Promise<SyncCatalogsSuccess> => {
      const advertiserId = ctx.account.ctx_metadata.advertiser_id;
      const out: SyncCatalogsSuccess['catalogs'] = [];
      for (const cat of req.catalogs ?? []) {
        const catalogId = cat.catalog_id ?? '';
        try {
          const created = await upstream.createCatalog(advertiserId, {
            catalog_id: catalogId,
            name: cat.name ?? catalogId,
            vertical: cat.type ?? 'product',
          });
          const items = (cat as { items?: unknown[] }).items ?? [];
          const itemCount = items.length;
          if (itemCount > 0) {
            await upstream.uploadCatalogItems(advertiserId, {
              catalog_id: created.catalog_id,
              items,
            });
          }
          out.push({
            catalog_id: catalogId,
            action: 'created',
            platform_id: created.catalog_id,
            item_count: itemCount,
            items_approved: itemCount,
            last_synced_at: new Date().toISOString(),
          });
        } catch (err) {
          out.push({
            catalog_id: catalogId,
            action: 'failed',
            errors: [
              {
                code: err instanceof AdcpError ? err.code : 'INVALID_REQUEST',
                message: err instanceof Error ? err.message : 'catalog sync failed',
              },
            ],
          });
        }
      }
      return { catalogs: out };
    },

    syncEventSources: async (req, ctx): Promise<SyncEventSourcesSuccess> => {
      const advertiserId = ctx.account.ctx_metadata.advertiser_id;
      const out: SyncEventSourcesSuccess['event_sources'] = [];
      for (const src of req.event_sources ?? []) {
        try {
          const allowedDomain = (src as { allowed_domains?: string[] }).allowed_domains?.[0];
          const created = await upstream.createPixel(advertiserId, {
            pixel_id: src.event_source_id ?? '',
            name: src.name ?? src.event_source_id ?? 'pixel',
            ...(allowedDomain !== undefined && { domain: allowedDomain }),
          });
          // Record buyer→upstream id mapping for later log_event translation.
          if (src.event_source_id) {
            eventSourceMap.set(eventSourceKey(advertiserId, src.event_source_id), created.pixel_id);
          }
          out.push({
            event_source_id: src.event_source_id ?? '',
            ...(src.name !== undefined && { name: src.name }),
            seller_id: created.pixel_id,
            event_types: src.event_types ?? [],
            action_source: 'website',
            managed_by: 'buyer',
            action: 'created',
            setup: {
              snippet: `<script>!function(){var p=document.createElement('script');p.src='https://pixel.example/${created.pixel_id}.js';document.head.appendChild(p);}();</script>`,
              snippet_type: 'javascript',
              instructions: 'Place this snippet in your <head> tag.',
            },
          });
        } catch (err) {
          out.push({
            event_source_id: src.event_source_id ?? '',
            action: 'failed',
            errors: [
              {
                code: err instanceof AdcpError ? err.code : 'INVALID_REQUEST',
                message: err instanceof Error ? err.message : 'event source sync failed',
              },
            ],
          });
        }
      }
      return { event_sources: out };
    },

    logEvent: async (req, ctx): Promise<LogEventSuccess> => {
      const advertiserId = ctx.account.ctx_metadata.advertiser_id;
      // Project AdCP `Event` onto the upstream walled-garden CAPI shape.
      // AdCP carries identifiers on the spec field `Event.user_match` (per
      // /schemas/3.0.4/core/user-match.json — `hashed_email`, `hashed_phone`,
      // `uids[]`, `click_id`, `client_ip` + `client_user_agent`). Project
      // these faithfully onto the upstream's `user_data` shape and pass the
      // batch unconditionally — let the upstream's identity policy decide
      // which events match. Dropping or synthesizing identifiers in the
      // adapter would either (a) hide buyer-fixable misconfigurations or
      // (b) fabricate a stable user-id signal the buyer never granted.
      const events = (req.events ?? []).map(e => {
        const eventTimeIso = e.event_time ?? new Date().toISOString();
        const eventTime = Math.floor(new Date(eventTimeIso).getTime() / 1000);
        const m = e.user_match;
        const userData: { external_id_sha256?: string; email_sha256?: string; phone_sha256?: string } = {};
        if (m?.hashed_email) userData.email_sha256 = m.hashed_email;
        if (m?.hashed_phone) userData.phone_sha256 = m.hashed_phone;
        // Walled gardens commonly accept hashed UIDs as `external_id_sha256`.
        // SWAP: production maps `m.uids[i].type` to your platform's specific
        // identifier slot (e.g. `madid`, `idfa`, `aaid`) per the CAPI docs.
        const firstUid = m?.uids?.[0]?.value;
        if (firstUid && /^[a-f0-9]{64}$/.test(firstUid)) userData.external_id_sha256 = firstUid;
        return {
          event_name: e.event_type,
          event_time: eventTime,
          user_data: userData,
        };
      });

      // Translate buyer's `event_source_id` → upstream `pixel_id`. The mock
      // assigns its own pixel_id at create time and ignores buyer-supplied
      // values, so subsequent log_event calls must look up the mapping.
      const buyerEventSourceId = req.event_source_id ?? '';
      const upstreamPixelId =
        eventSourceMap.get(eventSourceKey(advertiserId, buyerEventSourceId)) ?? buyerEventSourceId;
      // Tolerate upstream "no matchable events" (every event lacked a
      // matchable identifier in `user_match`). Surface as
      // `events_processed: 0` so the buyer can populate `user_match` and
      // retry; production should also include the upstream's per-event drop
      // reasons in `partial_failures[]` for actionable buyer errors.
      let tracked: { events_received: number; events_dropped: number };
      try {
        tracked = await upstream.trackEvents(advertiserId, {
          pixel_id: upstreamPixelId,
          events,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('no_matchable_events') || message.includes('events were dropped')) {
          return {
            events_received: req.events?.length ?? 0,
            events_processed: 0,
          };
        }
        throw err;
      }
      // AdCP wire: `events_received` is the buyer's submitted count;
      // `events_processed` is the count the seller will count toward
      // optimization/billing. Drop count = (no_match drops by adapter)
      // + (upstream drops for any reason).
      return {
        events_received: req.events?.length ?? 0,
        events_processed: tracked.events_received,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const platform = new SalesSocialAdapter();
const idempotencyStore = createIdempotencyStore({ backend: memoryBackend(), ttlSeconds: 86_400 });

serve(
  ({ taskStore }) =>
    createAdcpServerFromPlatform(platform, {
      name: 'hello-seller-adapter-social',
      version: '1.0.0',
      taskStore,
      idempotency: idempotencyStore,
      resolveSessionKey: ctx => {
        const acct = ctx.account as Account<AdvertiserMeta> | undefined;
        return acct?.id ?? 'anonymous';
      },
    }),
  {
    port: PORT,
    authenticate: verifyApiKey({
      keys: { [ADCP_AUTH_TOKEN]: { principal: 'compliance-runner' } },
    }),
  }
);

console.log(`sales-social adapter on http://127.0.0.1:${PORT}/mcp · upstream: ${UPSTREAM_URL}`);
