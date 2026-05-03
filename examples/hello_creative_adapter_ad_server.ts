/**
 * hello_creative_adapter_ad_server — worked starting point for an
 * AdCP creative agent (specialism `creative-ad-server`) that wraps an
 * upstream stateful creative library + tag generation platform.
 *
 * Closes #1460 (sub-issue of #1381 hello-adapter-family completion).
 * Closest neighbor: `hello_creative_adapter_template.ts`. The structural
 * delta is *additive*: promote `CreativeBuilderPlatform` to
 * `CreativeAdServerPlatform` (adds `listCreatives` + `getCreativeDelivery`),
 * stateful `syncCreatives` library, replace template-driven `buildCreative`
 * with tag-generation flow against a stored snippet template.
 *
 * Headline behavior:
 *   - `buildCreative` pulls a stored creative from the upstream library by
 *     id, calls `POST /v1/creatives/{id}/render` for macro substitution,
 *     and returns a `BuildCreativeSuccess` with `tag_url` pointing at a
 *     real iframe-embeddable `/serve/{id}` URL.
 *   - `previewCreative` (no-account tool) returns the same `tag_url` as a
 *     `preview_url` — adopters get a true URL they can iframe into the
 *     storyboard's preview pane.
 *   - `syncCreatives` writes to the upstream library; idempotency_key
 *     round-trips to upstream `client_request_id`.
 *   - `listCreatives` reads with cursor pagination, multi-id pass-through.
 *   - `getCreativeDelivery` synthesizes per-creative impressions/clicks.
 *
 * Fork this. Replace `upstream` with calls to your real backend. The
 * AdCP-facing platform methods stay the same.
 *
 * FORK CHECKLIST
 *   1. Replace every `// SWAP:` marker with calls to your backend.
 *   2. Replace `KNOWN_PUBLISHERS` with your tenant directory.
 *   3. Replace the `accounts.resolve(undefined)` fallback with the workspace
 *      tied to your principal (the env-driven default is a multi-tenant
 *      footgun in production; see recipe #11 in 6.7 migration guide).
 *   4. Replace `projectFormat()` defaults with the format catalog your
 *      platform actually exposes (closed-shape `Format.renders[]` per #1325).
 *   5. Validate: `node --test test/examples/hello-creative-adapter-ad-server.test.js`
 *   6. **DELETE the `// TEST-ONLY` blocks** before deploying:
 *      - sandbox-arm in `accounts.resolve` (resolves storyboard runner's
 *        synthetic `{publisher: …, sandbox: true}` refs to a known network
 *        and stamps `mode: 'sandbox'` so the framework gate admits the
 *        comply controller)
 *      - `complyTest:` config block (seeds storyboard creatives via
 *        `comply_test_controller`)
 *
 * Demo:
 *   npx @adcp/sdk@latest mock-server creative-ad-server --port 4452
 *   UPSTREAM_URL=http://127.0.0.1:4452 \
 *     npx tsx examples/hello_creative_adapter_ad_server.ts
 *   adcp storyboard run http://127.0.0.1:3008/mcp creative_ad_server \
 *     --auth sk_harness_do_not_use_in_prod
 *   curl http://127.0.0.1:4452/_debug/traffic
 */

import {
  AdcpError,
  createAdcpServerFromPlatform,
  createIdempotencyStore,
  createUpstreamHttpClient,
  memoryBackend,
  serve,
  verifyApiKey,
  type AccountStore,
  type Account,
  type CreativeAdServerPlatform,
  type DecisioningPlatform,
  type SyncCreativesRow,
} from '@adcp/sdk/server';
import type {
  BuildCreativeRequest,
  BuildCreativeSuccess,
  CreativeAsset,
  GetCreativeDeliveryRequest,
  GetCreativeDeliveryResponse,
  ListCreativeFormatsResponse,
  ListCreativesResponse,
  PreviewCreativeRequest,
  PreviewCreativeResponse,
} from '@adcp/sdk/types';

const UPSTREAM_URL = process.env['UPSTREAM_URL'] ?? 'http://127.0.0.1:4452';
const UPSTREAM_API_KEY = process.env['UPSTREAM_API_KEY'] ?? 'mock_creative_ad_server_key_do_not_use_in_prod';
const PORT = Number(process.env['PORT'] ?? 3008);
const ADCP_AUTH_TOKEN = process.env['ADCP_AUTH_TOKEN'] ?? 'sk_harness_do_not_use_in_prod';
const PUBLIC_AGENT_URL = process.env['PUBLIC_AGENT_URL'] ?? `http://127.0.0.1:${PORT}`;

const KNOWN_PUBLISHERS = ['creative-network.example', 'acmeoutdoor.example', 'pinnacle-agency.example'];
const SANDBOX_ID_PREFIX = 'sandbox_';

// ---------------------------------------------------------------------------
// Upstream client — SWAP for production.
// ---------------------------------------------------------------------------

interface UpstreamNetwork {
  network_code: string;
  display_name: string;
  adcp_publisher: string;
}

interface UpstreamFormat {
  format_id: string;
  name: string;
  channel: 'display' | 'video' | 'ctv' | 'audio';
  render_kind: 'fixed' | 'parameterized';
  width?: number;
  height?: number;
  duration_seconds?: number;
  accepted_mimes: string[];
}

interface UpstreamCreative {
  creative_id: string;
  network_code: string;
  advertiser_id: string;
  format_id: string;
  name: string;
  snippet?: string;
  click_url?: string;
  status: 'active' | 'paused' | 'archived' | 'rejected';
  created_at: string;
  updated_at: string;
}

interface UpstreamRenderResponse {
  creative_id: string;
  format_id: string;
  tag_html: string;
  tag_url: string;
  preview_url: string;
}

interface UpstreamDelivery {
  creative_id: string;
  reporting_period: { start: string; end: string };
  totals: { impressions: number; clicks: number; ctr: number };
  breakdown: Array<{ date: string; impressions: number; clicks: number }>;
}

const http = createUpstreamHttpClient({
  baseUrl: UPSTREAM_URL,
  auth: { kind: 'static_bearer', token: UPSTREAM_API_KEY },
});

const networkHeader = (networkCode: string): Record<string, string> => ({ 'X-Network-Code': networkCode });

const upstream = {
  async lookupNetwork(publisherDomain: string): Promise<UpstreamNetwork | null> {
    const { body } = await http.get<UpstreamNetwork>('/_lookup/network', { adcp_publisher: publisherDomain });
    return body;
  },

  async listFormats(networkCode: string): Promise<UpstreamFormat[]> {
    const { body } = await http.get<{ formats: UpstreamFormat[] }>(
      '/v1/formats',
      undefined,
      networkHeader(networkCode)
    );
    return body?.formats ?? [];
  },

  async listCreatives(
    networkCode: string,
    opts?: {
      advertiser_id?: string;
      format_id?: string;
      status?: string;
      created_after?: string;
      creative_ids?: string[];
      cursor?: string;
      limit?: number;
    }
  ): Promise<{ creatives: UpstreamCreative[]; next_cursor?: string }> {
    const params: Record<string, string> = {};
    if (opts?.advertiser_id) params['advertiser_id'] = opts.advertiser_id;
    if (opts?.format_id) params['format_id'] = opts.format_id;
    if (opts?.status) params['status'] = opts.status;
    if (opts?.created_after) params['created_after'] = opts.created_after;
    if (opts?.creative_ids?.length) params['creative_ids'] = opts.creative_ids.join(',');
    if (opts?.cursor) params['cursor'] = opts.cursor;
    if (opts?.limit !== undefined) params['limit'] = String(opts.limit);
    const { body } = await http.get<{ creatives: UpstreamCreative[]; next_cursor?: string }>(
      '/v1/creatives',
      params,
      networkHeader(networkCode)
    );
    return { creatives: body?.creatives ?? [], ...(body?.next_cursor && { next_cursor: body.next_cursor }) };
  },

  async getCreative(networkCode: string, creativeId: string): Promise<UpstreamCreative | null> {
    const { body } = await http.get<UpstreamCreative>(
      `/v1/creatives/${encodeURIComponent(creativeId)}`,
      undefined,
      networkHeader(networkCode)
    );
    return body;
  },

  async createCreative(
    networkCode: string,
    body: {
      name: string;
      advertiser_id: string;
      format_id?: string;
      upload_mime?: string;
      width?: number;
      height?: number;
      snippet?: string;
      click_url?: string;
      client_request_id?: string;
      /** Caller-supplied id override — TEST-ONLY path used by the comply
       *  seeder so storyboard fixtures can reference creatives by their
       *  declared alias. Production servers don't allow this. */
      creative_id?: string;
    }
  ): Promise<UpstreamCreative> {
    const r = await http.post<UpstreamCreative>('/v1/creatives', body, networkHeader(networkCode));
    if (r.body === null) {
      throw new AdcpError('CREATIVE_REJECTED', { message: 'upstream creative creation rejected' });
    }
    return r.body;
  },

  async renderCreative(
    networkCode: string,
    creativeId: string,
    context: Record<string, unknown>
  ): Promise<UpstreamRenderResponse> {
    const r = await http.post<UpstreamRenderResponse>(
      `/v1/creatives/${encodeURIComponent(creativeId)}/render`,
      { context },
      networkHeader(networkCode)
    );
    if (r.body === null) {
      throw new AdcpError('INVALID_REQUEST', { message: 'upstream render returned no body' });
    }
    return r.body;
  },

  async getDelivery(
    networkCode: string,
    creativeId: string,
    range: { start?: string; end?: string }
  ): Promise<UpstreamDelivery | null> {
    const params: Record<string, string> = {};
    if (range.start) params['start'] = range.start;
    if (range.end) params['end'] = range.end;
    const { body } = await http.get<UpstreamDelivery>(
      `/v1/creatives/${encodeURIComponent(creativeId)}/delivery`,
      params,
      networkHeader(networkCode)
    );
    return body;
  },
};

// ---------------------------------------------------------------------------
// AdCP-side adapter — typed against CreativeAdServerPlatform.
// ---------------------------------------------------------------------------

interface NetworkMeta {
  network_code: string;
  publisher_domain: string;
  [key: string]: unknown;
}

const FORMAT_AGENT_URL = PUBLIC_AGENT_URL;

/** Project upstream format → AdCP `Format` shape with closed-shape
 *  `renders[]` per #1325. Adapter consumes `GET /v1/formats` then
 *  projects each entry. */
function projectFormat(f: UpstreamFormat): ListCreativeFormatsResponse['formats'][number] {
  // Display fixed formats: emit dimensions on a single 'main' render.
  if (f.render_kind === 'fixed' && f.channel === 'display' && f.width !== undefined && f.height !== undefined) {
    return {
      format_id: { agent_url: FORMAT_AGENT_URL, id: f.format_id },
      name: f.name,
      renders: [
        {
          role: 'main',
          dimensions: { width: f.width, height: f.height, unit: 'px' as const },
        },
      ],
    };
  }
  // Video / CTV: project at 1080p baseline.
  if (f.render_kind === 'fixed' && (f.channel === 'video' || f.channel === 'ctv')) {
    return {
      format_id: { agent_url: FORMAT_AGENT_URL, id: f.format_id },
      name: f.name,
      renders: [
        {
          role: 'main',
          dimensions: { width: 1920, height: 1080, unit: 'px' as const },
        },
      ],
    };
  }
  // Parameterized — placeholder dimensions for the worked example. Real
  // adopters populate `accepts_parameters[]` (typed via the
  // `parameterizedRender(...)` builder from `@adcp/sdk` per #1325) and
  // surface dimensions per instantiation. The 1x1 baseline keeps the
  // wire response schema-valid (`width`/`height` are exclusiveMinimum 0).
  return {
    format_id: { agent_url: FORMAT_AGENT_URL, id: f.format_id },
    name: f.name,
    renders: [{ role: 'main', dimensions: { width: 1, height: 1, unit: 'px' as const } }],
  };
}

/** Project upstream creative → AdCP `CreativeAsset`. The list-creatives
 *  response schema requires `creative_id`, `name`, `format_id`, `status`,
 *  `created_date`, `updated_date`. We wrap the upstream snippet as a single
 *  inline html asset so adopters see how `assets` is keyed; production
 *  sellers project the upstream's structured asset graph (image_url,
 *  video_url, click_url, headline, etc.) here. */
function projectCreative(c: UpstreamCreative): CreativeAsset {
  return {
    creative_id: c.creative_id,
    name: c.name,
    format_id: { agent_url: FORMAT_AGENT_URL, id: c.format_id },
    status: mapCreativeStatus(c.status),
    created_date: c.created_at,
    updated_date: c.updated_at,
    assets: {
      ...(c.snippet !== undefined && {
        snippet: { asset_type: 'html', content: c.snippet },
      }),
      ...(c.click_url !== undefined && {
        click_url: { asset_type: 'url', url: c.click_url },
      }),
    },
  } as unknown as CreativeAsset;
}

function mapCreativeStatus(s: UpstreamCreative['status']): 'approved' | 'pending_review' | 'rejected' {
  if (s === 'rejected') return 'rejected';
  // active / paused / archived all surface as approved for the buyer's view —
  // pause/archive are seller-side library hygiene, not buyer review state.
  return 'approved';
}

class CreativeAdServerAdapter implements DecisioningPlatform<Record<string, never>, NetworkMeta> {
  capabilities = {
    specialisms: ['creative-ad-server'] as const,
    channels: ['display', 'olv', 'ctv'] as const,
    pricingModels: [] as const,
    config: {},
    // Empty discovery block — `complyTest:` config below wires the seed.creative
    // handler. The framework auto-derives the `scenarios` projection from the
    // supplied adapters, so the explicit `scenarios: [...]` list isn't needed.
    compliance_testing: {},
  };

  accounts: AccountStore<NetworkMeta> = {
    resolve: async ref => {
      // No-account tools (`previewCreative`, `listCreativeFormats`) hand
      // `undefined` to resolve. Return the default-listing network so
      // the format catalog query has tenant context.
      if (!ref) {
        const network = await upstream.lookupNetwork(KNOWN_PUBLISHERS[0] ?? 'creative-network.example');
        if (!network) return null;
        return {
          id: network.network_code,
          name: network.display_name,
          status: 'active',
          brand: { domain: network.adcp_publisher },
          ctx_metadata: { network_code: network.network_code, publisher_domain: network.adcp_publisher },
        };
      }
      if ('account_id' in ref) {
        // Production: persist `account_id → network_code` during sync_accounts
        // and serve account_id lookups from there. The worked example routes
        // any account_id to the ACME sandbox network so storyboard scenarios
        // that reference seeded ids (`acct_acme_creative`) resolve cleanly.
        const network = await upstream.lookupNetwork('acmeoutdoor.example');
        if (!network) return null;
        return {
          id: ref.account_id,
          name: network.display_name,
          status: 'active',
          mode: 'sandbox',
          brand: { domain: network.adcp_publisher },
          ctx_metadata: { network_code: network.network_code, publisher_domain: network.adcp_publisher },
        };
      }

      // ─── TEST-ONLY: cascade-scenario sandbox-arm ─────────────────────
      // DELETE BEFORE DEPLOYING. Stamps `mode: 'sandbox'` to admit the
      // framework's comply_test_controller gate (#1435 phase 3).
      if (ref.sandbox === true) {
        const sandboxDomain = 'acmeoutdoor.example';
        const network = await upstream.lookupNetwork(sandboxDomain);
        if (!network) return null;
        return {
          id: `${SANDBOX_ID_PREFIX}${network.network_code}`,
          name: `Sandbox: ${network.display_name}`,
          status: 'active',
          mode: 'sandbox',
          ...(ref.operator !== undefined && { operator: ref.operator }),
          brand: { domain: ref.brand?.domain ?? sandboxDomain },
          ctx_metadata: { network_code: network.network_code, publisher_domain: network.adcp_publisher },
        };
      }
      // ─── /TEST-ONLY ──────────────────────────────────────────────────

      const publisherDomain = ref.brand?.domain;
      if (!publisherDomain) return null;
      const network = await upstream.lookupNetwork(publisherDomain);
      if (!network) return null;
      return {
        id: network.network_code,
        name: network.display_name,
        status: 'active',
        ...(ref.operator !== undefined && { operator: ref.operator }),
        brand: { domain: network.adcp_publisher },
        ctx_metadata: { network_code: network.network_code, publisher_domain: network.adcp_publisher },
      };
    },
  };

  creative: CreativeAdServerPlatform<NetworkMeta> = {
    /**
     * Build / retrieve creative tags. Two invocation modes per the spec:
     *   - Library lookup: `req.creative_id` references an existing creative
     *   - Inline build: `req.creative_manifest` carries a fresh asset
     *
     * The worked example handles library-lookup mode; inline-build registers
     * the creative first (push to upstream) then renders. SWAP for adapters
     * that don't support inline build to throw INVALID_REQUEST instead.
     */
    buildCreative: async (req: BuildCreativeRequest, ctx): Promise<BuildCreativeSuccess> => {
      const networkCode = ctx.account.ctx_metadata.network_code;
      const creativeId = (req as { creative_id?: string }).creative_id;
      const creativeManifest = (req as { creative_manifest?: { creative_id?: string; assets?: unknown } })
        .creative_manifest;
      const mediaBuyId = (req as { media_buy_id?: string }).media_buy_id;
      const packageId = (req as { package_id?: string }).package_id;

      let creative: UpstreamCreative | null;
      if (creativeId) {
        creative = await upstream.getCreative(networkCode, creativeId);
        if (!creative) {
          throw new AdcpError('CREATIVE_NOT_FOUND', {
            message: `creative ${creativeId} not found in this seller's network`,
            field: 'creative_id',
            recovery: 'terminal',
          });
        }
      } else if (creativeManifest) {
        // Inline-build path: register the creative first.
        const advertiserId = ctx.account.id;
        const targetFormatId = (req as { target_format_id?: { id?: string } }).target_format_id?.id;
        const created = await upstream.createCreative(networkCode, {
          name: creativeManifest.creative_id ?? 'Inline build',
          advertiser_id: advertiserId,
          ...(targetFormatId !== undefined && { format_id: targetFormatId }),
        });
        creative = created;
      } else {
        throw new AdcpError('INVALID_REQUEST', {
          message: 'either creative_id or creative_manifest is required',
          recovery: 'correctable',
        });
      }

      // Tag generation — substitutes macros into the stored snippet.
      // Production adopters thread placement-specific context here:
      // click_url derived from media_buy + package, impression pixel from
      // viewability vendor, cb (cache-buster) random.
      const ctxMacros: Record<string, unknown> = {
        ...(mediaBuyId && { media_buy_id: mediaBuyId }),
        ...(packageId && { package_id: packageId }),
      };
      const rendered = await upstream.renderCreative(networkCode, creative.creative_id, ctxMacros);

      // BuildCreativeResponse is a oneOf — variant 0 wraps a single
      // `creative_manifest`, variant 1 carries `creative_manifests[]`,
      // variant 2 is errors. We always emit single. The manifest's
      // `additionalProperties: false` constraint excludes `creative_id`
      // and `name` from the manifest body — only `format_id`, `assets`,
      // `rights`, `industry_identifiers`, `provenance`, `ext` are allowed.
      // Each `assets[key]` is a discriminated AssetVariant — `asset_type`
      // selects the matching schema (html requires `content`, etc.).
      return {
        creative_manifest: {
          format_id: { agent_url: FORMAT_AGENT_URL, id: creative.format_id },
          assets: {
            tag: { asset_type: 'html', content: rendered.tag_html },
          },
        },
      } as unknown as BuildCreativeSuccess;
    },

    /**
     * Preview-only — sandbox URL. NoAccountCtx narrow because the wire
     * request doesn't carry `account`. Resolver synthesizes a fallback
     * (KNOWN_PUBLISHERS[0]) so we have tenant context.
     */
    previewCreative: async (req: PreviewCreativeRequest, ctx): Promise<PreviewCreativeResponse> => {
      // No-account narrow: ctx.account is `Account<NetworkMeta> | undefined`
      // per the type. Defensive guard per migration recipe #11.
      const acct = ctx.account as Account<NetworkMeta> | undefined;
      if (!acct) {
        throw new AdcpError('INVALID_REQUEST', {
          message: 'preview requires a default workspace; account resolution returned null',
        });
      }
      const networkCode = acct.ctx_metadata.network_code;
      const creativeId = (req as { creative_id?: string }).creative_id;
      if (!creativeId) {
        throw new AdcpError('INVALID_REQUEST', {
          message: 'creative_id is required for preview',
          field: 'creative_id',
        });
      }
      const creative = await upstream.getCreative(networkCode, creativeId);
      if (!creative) {
        throw new AdcpError('CREATIVE_NOT_FOUND', {
          message: `creative ${creativeId} not found`,
          field: 'creative_id',
        });
      }
      const rendered = await upstream.renderCreative(networkCode, creativeId, {});
      return {
        response_type: 'single',
        previews: [
          {
            preview_id: `prv_${creative.creative_id}`,
            renders: [
              {
                render_id: `rnd_${creative.creative_id}`,
                preview_url: rendered.preview_url,
                role: 'primary',
              },
            ],
            input: { name: 'default' },
          },
        ],
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      } as unknown as PreviewCreativeResponse;
    },

    listCreativeFormats: async (_req, _ctx): Promise<ListCreativeFormatsResponse> => {
      // No-account tool. Use the default workspace's catalog. Production
      // sellers expose a global format catalog or the workspace tied to
      // the API key's principal.
      const networkCode = NETWORK_DEFAULT_CODE;
      const upstreamFormats = await upstream.listFormats(networkCode);
      return { formats: upstreamFormats.map(projectFormat) };
    },

    syncCreatives: async (creatives: CreativeAsset[], ctx): Promise<SyncCreativesRow[]> => {
      const networkCode = ctx.account.ctx_metadata.network_code;
      const advertiserId = ctx.account.id;
      const rows: SyncCreativesRow[] = [];
      for (const c of creatives) {
        const opaque = c as unknown as Record<string, unknown>;
        const fmtRef = opaque['format_id'] as { id?: string } | string | undefined;
        const formatId = typeof fmtRef === 'string' ? fmtRef : fmtRef?.id;
        const idempotencyHint =
          typeof opaque['creative_id'] === 'string' ? (opaque['creative_id'] as string) : undefined;
        // Extract upstream-specific fields the AdCP `CreativeAsset` shape
        // doesn't carry directly. Adopters whose backend takes the structured
        // assets[] map should project differently; this worked example wires
        // a single inline html snippet + click_url for storyboard simplicity.
        const snippet = typeof opaque['snippet'] === 'string' ? (opaque['snippet'] as string) : undefined;
        const clickUrl = typeof opaque['click_url'] === 'string' ? (opaque['click_url'] as string) : undefined;
        try {
          const created = await upstream.createCreative(networkCode, {
            name: typeof opaque['name'] === 'string' ? (opaque['name'] as string) : 'Untitled',
            advertiser_id: advertiserId,
            ...(formatId !== undefined && { format_id: formatId }),
            ...(snippet !== undefined && { snippet }),
            ...(clickUrl !== undefined && { click_url: clickUrl }),
            ...(idempotencyHint !== undefined && { client_request_id: idempotencyHint }),
          });
          rows.push({
            creative_id: created.creative_id,
            action: 'created',
            status: 'approved',
          });
        } catch (e) {
          rows.push({
            creative_id: idempotencyHint ?? 'unknown',
            action: 'failed',
            status: 'rejected',
            errors: [
              {
                code: e instanceof AdcpError ? e.code : 'CREATIVE_REJECTED',
                message: e instanceof Error ? e.message : 'creative sync failed',
              },
            ],
          });
        }
      }
      return rows;
    },

    listCreatives: async (req, ctx) => {
      const networkCode = ctx.account.ctx_metadata.network_code;
      // Multi-id pass-through per #1342: `filter.creative_ids` arrays must
      // round-trip every id, not just the first.
      const filter = (
        req as { filter?: { creative_ids?: string[]; advertiser_id?: string; format_id?: string; status?: string } }
      ).filter;
      const cursor = (req as { cursor?: string }).cursor;
      const limit = (req as { limit?: number }).limit;
      const result = await upstream.listCreatives(networkCode, {
        ...(filter?.creative_ids?.length && { creative_ids: filter.creative_ids }),
        ...(filter?.advertiser_id && { advertiser_id: filter.advertiser_id }),
        ...(filter?.format_id && { format_id: filter.format_id }),
        ...(filter?.status && { status: filter.status }),
        ...(cursor && { cursor }),
        ...(limit !== undefined && { limit }),
      });
      // The platform interface uses `tools.generated.ListCreativesResponse`
      // which carries `query_summary` + `pagination` + `creatives` keys.
      type R = Awaited<ReturnType<NonNullable<CreativeAdServerPlatform<NetworkMeta>['listCreatives']>>>;
      const projected = result.creatives.map(projectCreative);
      const response: R = {
        query_summary: {
          total_matching: projected.length,
          returned: projected.length,
        },
        pagination: {
          has_more: result.next_cursor !== undefined,
          ...(result.next_cursor !== undefined && { cursor: result.next_cursor }),
          total_count: projected.length,
        },
        creatives: projected,
      } as unknown as R;
      return response;
    },

    getCreativeDelivery: async (req: GetCreativeDeliveryRequest, ctx): Promise<GetCreativeDeliveryResponse> => {
      const networkCode = ctx.account.ctx_metadata.network_code;
      // Multi-id pass-through per #1342 + #1410. `filter.creative_ids` arrays
      // must fan out per id; truncating to ids[0] is a correctness bug the
      // framework dev-mode warns on.
      const creativeIds = (req as { filter?: { creative_ids?: string[] } }).filter?.creative_ids ?? [];
      const start = (req as { reporting_period?: { start?: string } }).reporting_period?.start;
      const end = (req as { reporting_period?: { end?: string } }).reporting_period?.end;

      const deliveries = await Promise.all(
        creativeIds.map(async id => {
          const d = await upstream.getDelivery(networkCode, id, {
            ...(start !== undefined && { start }),
            ...(end !== undefined && { end }),
          });
          if (!d) return null;
          return d;
        })
      );
      const present = deliveries.filter((d): d is UpstreamDelivery => d !== null);
      return {
        currency: 'USD',
        reporting_period: {
          start: present[0]?.reporting_period.start ?? new Date().toISOString(),
          end: present[0]?.reporting_period.end ?? new Date().toISOString(),
        },
        creatives: present.map(d => ({
          creative_id: d.creative_id,
          impressions: d.totals.impressions,
          clicks: d.totals.clicks,
        })),
      } as unknown as GetCreativeDeliveryResponse;
    },
  };
}

// Default network used by no-account tools (`listCreativeFormats`).
// SWAP: real platforms either expose a global format catalog or derive
// the listing workspace from the API key's principal — a runtime env var
// is a multi-tenant footgun. See migration guide §11 (NoAccountCtx).
const NETWORK_DEFAULT_CODE = process.env['DEFAULT_LISTING_NETWORK'] ?? 'net_creative_us';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const platform = new CreativeAdServerAdapter();
const idempotencyStore = createIdempotencyStore({ backend: memoryBackend(), ttlSeconds: 86_400 });

// ─── TEST-ONLY: comply_test_controller seed adapter ────────────────────
// DELETE BEFORE DEPLOYING. The storyboard's `controller_seeding: true`
// fires `seed.creative` for each fixture entry; we forward to the upstream
// mock's POST /v1/creatives so the seeded creative is real in the library.
// Production sellers ship without this — their library state is owned by
// their UI / API ingestion, not the comply controller.
async function seedCreativeOnUpstream(creativeId: string, fixture: Record<string, unknown>): Promise<void> {
  // Pick the first known network — storyboard fixtures aren't network-scoped,
  // so we route them to the default sandbox network.
  const network = await upstream.lookupNetwork('acmeoutdoor.example');
  if (!network) return;
  try {
    await upstream.createCreative(network.network_code, {
      name: typeof fixture['name'] === 'string' ? fixture['name'] : creativeId,
      advertiser_id: typeof fixture['advertiser_id'] === 'string' ? fixture['advertiser_id'] : 'adv_seeded',
      format_id:
        typeof fixture['format_id'] === 'object' &&
        fixture['format_id'] !== null &&
        typeof (fixture['format_id'] as { id?: string }).id === 'string'
          ? (fixture['format_id'] as { id: string }).id
          : 'display_300x250',
      client_request_id: creativeId,
      // Pass the storyboard-declared id through — the mock allows this
      // override on the TEST-ONLY path so cascade fixtures can reference
      // creatives by alias instead of resolving server-assigned ids.
      creative_id: creativeId,
    });
  } catch {
    // Idempotent — already seeded is fine.
  }
}
// ─── /TEST-ONLY ────────────────────────────────────────────────────────

serve(
  ({ taskStore }) =>
    createAdcpServerFromPlatform(platform, {
      name: 'hello-creative-adapter-ad-server',
      version: '1.0.0',
      taskStore,
      idempotency: idempotencyStore,
      resolveSessionKey: ctx => {
        const acct = ctx.account as Account<NetworkMeta> | undefined;
        return acct?.id ?? 'anonymous';
      },
      complyTest: {
        seed: {
          creative: async ({ creative_id, fixture }) => {
            await seedCreativeOnUpstream(creative_id, fixture);
          },
        },
      },
    }),
  {
    port: PORT,
    authenticate: verifyApiKey({
      keys: { [ADCP_AUTH_TOKEN]: { principal: 'compliance-runner' } },
    }),
  }
);

console.log(`creative-ad-server adapter on http://127.0.0.1:${PORT}/mcp · upstream: ${UPSTREAM_URL}`);
