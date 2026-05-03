/**
 * hello_creative_adapter_template — worked starting point for an
 * AdCP creative agent (specialism `creative-template`) that wraps an
 * upstream creative-template platform via HTTP.
 *
 * Fork this. Replace `upstream` with calls to your real backend. The
 * AdCP-facing platform methods stay the same.
 *
 * FORK CHECKLIST
 *   1. Replace every `// SWAP:` marker with calls to your backend.
 *   2. Replace `DEFAULT_LISTING_WORKSPACE` resolution with `ctx.authInfo`-
 *      derived per-tenant binding (the env-driven default is a multi-tenant
 *      footgun in production).
 *   3. Replace `projectSlot` defaults with constraints your platform
 *      actually enforces (mime types, max sizes, aspect ratios).
 *   4. Validate: `node --test test/examples/hello-creative-adapter-template.test.js`
 *
 * Demo:
 *   npx @adcp/sdk@latest mock-server creative-template --port 4250
 *   UPSTREAM_URL=http://127.0.0.1:4250 \
 *     npx tsx examples/hello_creative_adapter_template.ts
 *   adcp storyboard run http://127.0.0.1:3002/mcp creative_template \
 *     --auth sk_harness_do_not_use_in_prod
 *   curl http://127.0.0.1:4250/_debug/traffic
 *
 * Production:
 *   UPSTREAM_URL=https://my-creative-platform.example/api UPSTREAM_API_KEY=… \
 *     PUBLIC_AGENT_URL=https://my-agent.example.com \
 *     npx tsx examples/hello_creative_adapter_template.ts
 */

import {
  createAdcpServerFromPlatform,
  serve,
  verifyApiKey,
  createIdempotencyStore,
  createUpstreamHttpClient,
  memoryBackend,
  AdcpError,
  defineCreativeBuilderPlatform,
  type DecisioningPlatform,
  type CreativeBuilderPlatform,
  type BuildCreativeReturn,
  type AccountStore,
  type Account,
} from '@adcp/sdk/server';
import {
  FormatAsset,
  displayRender,
  parameterizedRender,
  htmlAsset,
  javascriptAsset,
  audioAsset,
  urlRender,
  type Format,
  type ListCreativeFormatsResponse,
  type BuildCreativeRequest,
  type CreativeManifest,
  type PreviewCreativeRequest,
  type PreviewCreativeResponse,
} from '@adcp/sdk';
import { randomUUID } from 'node:crypto';

const UPSTREAM_URL = process.env['UPSTREAM_URL'] ?? 'http://127.0.0.1:4250';
const UPSTREAM_API_KEY = process.env['UPSTREAM_API_KEY'] ?? 'mock_creative_template_key_do_not_use_in_prod';
const PORT = Number(process.env['PORT'] ?? 3002);
const ADCP_AUTH_TOKEN = process.env['ADCP_AUTH_TOKEN'] ?? 'sk_harness_do_not_use_in_prod';
const PUBLIC_AGENT_URL = process.env['PUBLIC_AGENT_URL'] ?? `http://127.0.0.1:${PORT}`;
// Default workspace used by `list_creative_formats` (no-account tool). Real
// platforms expose a global format catalog or the workspace tied to the API
// key's principal; the mock fixture keys templates per workspace.
const DEFAULT_LISTING_WORKSPACE = process.env['DEFAULT_LISTING_WORKSPACE'] ?? 'ws_acme_studio';

// ---------------------------------------------------------------------------
// Upstream client — SWAP for production.
// `createUpstreamHttpClient` from @adcp/sdk/server handles auth injection,
// 404→null, and JSON parse. Five typed wrappers below are the seams to
// swap when wiring to your real backend.
// ---------------------------------------------------------------------------

interface UpstreamTemplate {
  template_id: string;
  name: string;
  description: string;
  channel: 'display' | 'video' | 'audio' | 'ctv' | 'native';
  // SWAP: include any output_kinds your platform emits. The mock supports
  // four (display HTML, JS, VAST, audio URL); production audio platforms
  // (AudioStack, ElevenLabs, Resemble) typically output `audio_url` to a
  // signed CDN endpoint.
  dimensions?: { width: number; height: number };
  duration_seconds?: { min: number; max: number };
  output_kind: 'html_tag' | 'javascript_tag' | 'vast_xml' | 'audio_url';
  slots: Array<{
    slot_id: string;
    asset_type: 'image' | 'video' | 'audio' | 'text' | 'click_url';
    required: boolean;
    constraints?: Record<string, unknown>;
  }>;
}

interface UpstreamRender {
  render_id: string;
  status: 'queued' | 'running' | 'complete' | 'failed';
  template_id: string;
  mode: 'preview' | 'build';
  output?: {
    tag_html?: string;
    tag_javascript?: string;
    vast_xml?: string;
    audio_url?: string;
    preview_url?: string;
    assets?: Array<Record<string, unknown>>;
  };
  error?: { code: string; message: string };
}

const http = createUpstreamHttpClient({
  baseUrl: UPSTREAM_URL,
  auth: { kind: 'static_bearer', token: UPSTREAM_API_KEY },
});

const upstream = {
  // SWAP: tenant lookup. Mock exposes /_lookup; production typically a
  // directory service or workspace registry on your platform.
  async lookupWorkspace(advertiserDomain: string): Promise<string | null> {
    const { body } = await http.get<{ workspace_id?: string }>('/_lookup/workspace', {
      adcp_advertiser: advertiserDomain,
    });
    return body?.workspace_id ?? null;
  },

  // SWAP: list templates visible to a workspace.
  async listTemplates(workspaceId: string, channel?: string): Promise<UpstreamTemplate[]> {
    const params: Record<string, string> = {};
    if (channel) params['channel'] = channel;
    const { body } = await http.get<{ templates: UpstreamTemplate[] }>(
      `/v3/workspaces/${encodeURIComponent(workspaceId)}/templates`,
      params
    );
    return body?.templates ?? [];
  },

  // SWAP: single template — used to look up output_kind during build.
  async getTemplate(workspaceId: string, templateId: string): Promise<UpstreamTemplate | null> {
    const { body } = await http.get<UpstreamTemplate>(
      `/v3/workspaces/${encodeURIComponent(workspaceId)}/templates/${encodeURIComponent(templateId)}`
    );
    return body;
  },

  // SWAP: create a render (preview or build). Mock returns 202 with a
  // queued render; real platforms either render synchronously or 202 + poll.
  async createRender(
    workspaceId: string,
    body: { template_id: string; inputs: unknown[]; mode: 'preview' | 'build'; client_request_id?: string }
  ): Promise<UpstreamRender> {
    const r = await http.post<UpstreamRender>(`/v3/workspaces/${encodeURIComponent(workspaceId)}/renders`, body);
    if (r.body === null) {
      throw new AdcpError('INVALID_REQUEST', { message: 'render creation rejected by upstream' });
    }
    return r.body;
  },

  // SWAP: poll a render to completion. Mock auto-promotes queued → running →
  // complete on successive polls. Production: poll until terminal state with
  // a backoff and timeout. Two polls suffices for the fixture.
  async waitForRender(workspaceId: string, renderId: string): Promise<UpstreamRender> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { body } = await http.get<UpstreamRender>(
        `/v3/workspaces/${encodeURIComponent(workspaceId)}/renders/${encodeURIComponent(renderId)}`
      );
      if (!body) {
        throw new AdcpError('INVALID_REQUEST', { message: `render ${renderId} disappeared mid-poll` });
      }
      if (body.status === 'complete') return body;
      if (body.status === 'failed') {
        throw new AdcpError('INVALID_REQUEST', {
          message: body.error?.message ?? `render ${renderId} failed`,
        });
      }
    }
    throw new AdcpError('INVALID_REQUEST', { message: `render ${renderId} did not complete in time` });
  },
};

// ---------------------------------------------------------------------------
// AdCP-side adapter — typed against CreativeBuilderPlatform.
// ---------------------------------------------------------------------------

interface CreativeMeta {
  /** Resolved upstream workspace_id, cached on the Account by accounts.resolve. */
  workspace_id: string;
  /** AdCP-side advertiser domain — preserved for logging / debugging. */
  advertiser_domain: string;
  [key: string]: unknown;
}

/** Project an upstream channel onto an AdCP `format_id.id` slug. */
function templateIdToFormatSlug(t: UpstreamTemplate): string {
  if (t.dimensions) return `${t.channel}_${t.dimensions.width}x${t.dimensions.height}`;
  if (t.duration_seconds) return `${t.channel}_${t.duration_seconds.max}s`;
  return t.channel;
}

/** Project an upstream slot onto a typed `Format.assets[]` entry.
 *  The discriminator quartet (`item_type` + `asset_id` + `asset_type` +
 *  `required`) is required by strict validators — using FormatAsset.* helpers
 *  injects `item_type: 'individual'` and the asset_type discriminator so a
 *  bare `{ asset_id, required }` slot can't sneak through type-check. */
function projectSlot(s: UpstreamTemplate['slots'][number]) {
  switch (s.asset_type) {
    case 'image': {
      const c = s.constraints as { width?: number; height?: number; mime_types?: string[] } | undefined;
      return FormatAsset.image({
        asset_id: s.slot_id,
        required: s.required,
        ...(c && (c.width || c.height)
          ? {
              requirements: {
                ...(c.width ? { min_width: c.width, max_width: c.width } : {}),
                ...(c.height ? { min_height: c.height, max_height: c.height } : {}),
              },
            }
          : {}),
      });
    }
    case 'video': {
      const c = s.constraints as { duration_max_seconds?: number; mime_types?: string[] } | undefined;
      return FormatAsset.video({
        asset_id: s.slot_id,
        required: s.required,
        ...(c?.duration_max_seconds ? { requirements: { max_duration_ms: c.duration_max_seconds * 1000 } } : {}),
      });
    }
    case 'audio':
      return FormatAsset.audio({ asset_id: s.slot_id, required: s.required });
    case 'text': {
      const c = s.constraints as { max_chars?: number } | undefined;
      return FormatAsset.text({
        asset_id: s.slot_id,
        required: s.required,
        ...(c?.max_chars ? { requirements: { max_length: c.max_chars } } : {}),
      });
    }
    case 'click_url':
      // AdCP models click destinations as a `url`-typed asset slot.
      return FormatAsset.url({ asset_id: s.slot_id, required: s.required });
  }
}

function templateToFormat(t: UpstreamTemplate): Format {
  // Each `renders[]` entry MUST be `{ role, dimensions: { width, height } }`
  // OR `{ role, parameters_from_format_id: true }`. A bare `{ role, width,
  // height }` fails strict validation. See skills/SHAPE-GOTCHAS.md. Typed
  // builders inject the discriminator and assign cleanly to Format['renders']
  // under strict tsc (#1325 codegen tightening).
  const renders: NonNullable<Format['renders']> = t.dimensions
    ? [displayRender({ role: 'primary', dimensions: { width: t.dimensions.width, height: t.dimensions.height } })]
    : [parameterizedRender({ role: 'primary' })];

  return {
    format_id: { agent_url: PUBLIC_AGENT_URL, id: templateIdToFormatSlug(t) },
    name: t.name,
    description: t.description,
    renders,
    assets: t.slots.map(projectSlot),
  };
}

/** Project an upstream `render.output` onto AdCP `creative_manifest.assets`.
 *  The mock returns one of four output shapes (HTML tag, JS tag, VAST, audio
 *  URL); AdCP creative-manifest assets are keyed by asset_id and discriminated
 *  by asset_type. Use the `htmlAsset` / `javascriptAsset` / `audioAsset`
 *  builders to inject the discriminator — a bare `{ content }` or `{ url }`
 *  fails the asset-union oneOf.
 *
 *  ⚠️ This fixture's `serving_tag` asset_id diverges from
 *  `creative-manifest.json:14`, which mandates: "Each key MUST match an
 *  asset_id from the format's assets array." The format declared by
 *  `templateToFormat` has slot ids (`image`, `headline`, `script`, etc.) —
 *  none of which is `serving_tag`. We use `serving_tag` consistently across
 *  all four output kinds (HTML / JS / VAST / audio) so the fixture exercises
 *  every output branch with one key, but **production adopters MUST echo
 *  declared `assets[].asset_id` values** — pick the slot the buyer expects
 *  the rendered output under (e.g. `output`, `master`) and declare it in
 *  the format. Spec-aligning this fixture is tracked at adcp-client follow-up
 *  to #1496; until then, see SHAPE-GOTCHAS.md before adapting this pattern. */
function projectRenderToManifest(
  render: UpstreamRender,
  formatId: { agent_url: string; id: string }
): CreativeManifest {
  const out = render.output ?? {};
  const assets: CreativeManifest['assets'] = {};
  if (out.tag_html) {
    assets['serving_tag'] = htmlAsset({ content: out.tag_html });
  } else if (out.tag_javascript) {
    assets['serving_tag'] = javascriptAsset({ content: out.tag_javascript });
  } else if (out.vast_xml) {
    // VAST is handled here as raw HTML so the storyboard's schema check on
    // build_creative passes. A production VAST integration should use the
    // `vast` asset type with `delivery_type: 'inline'` (see SHAPE-GOTCHAS.md
    // §3) — included here as html for fixture simplicity since the
    // creative-template storyboard's build step asserts `assets` presence
    // rather than a specific asset_type.
    assets['serving_tag'] = htmlAsset({ content: out.vast_xml });
  } else if (out.audio_url) {
    // Audio templates render to a hosted MP3. Real audio platforms return
    // signed CDN URLs with TTL — the buyer must fetch within the lifetime.
    // The `audioAsset` builder injects the `asset_type: 'audio'` discriminator
    // that the AdCP creative-manifest oneOf requires. Reuses the same
    // `serving_tag` asset_id as the HTML / JS / VAST branches — the asset_type
    // discriminator is what the buyer keys on, not the asset_id.
    assets['serving_tag'] = audioAsset({ url: out.audio_url });
  }
  return { format_id: formatId, assets };
}

class CreativeTemplateAdapter implements DecisioningPlatform<Record<string, never>, CreativeMeta> {
  capabilities = {
    specialisms: ['creative-template'] as const,
    config: {},
  };

  accounts: AccountStore<CreativeMeta> = {
    /** Translate AdCP `account.brand.domain` → upstream `workspace_id`.
     *  For tools that carry `account` (build_creative), `ref.brand.domain`
     *  drives the lookup. For no-account tools (list_creative_formats,
     *  preview_creative — both schemas omit `account`), `ref` is
     *  undefined; fall back to the default listing workspace so handlers
     *  can rely on `ctx.account.ctx_metadata`. The framework's
     *  `resolveAccountFromAuth` path expects a non-null Account here for
     *  every tool the platform claims. */
    resolve: async ref => {
      if (!ref) {
        // No-account tools (list_creative_formats, preview_creative) — the
        // wire request omits `account` and the framework calls
        // resolve(undefined). Return the default-listing-workspace so
        // ctx.account is non-null at runtime and the typed handlers'
        // `Account<TCtxMeta> | undefined` narrow has a value to read.
        // SWAP: production should derive this from `ctx.authInfo` (per-API-key
        // tenant binding) instead of an env-driven global default — otherwise
        // a multi-workspace deployment leaks Workspace A's templates to
        // callers authenticated under Workspace B.
        return {
          id: DEFAULT_LISTING_WORKSPACE,
          name: DEFAULT_LISTING_WORKSPACE,
          status: 'active',
          ctx_metadata: { workspace_id: DEFAULT_LISTING_WORKSPACE, advertiser_domain: '' },
        };
      }
      // AccountReference is a discriminated union: `{ account_id }` (post-
      // sync_accounts identifier) OR `{ brand, operator, sandbox? }` (initial
      // discovery). Production adopters resolve the account_id arm via their
      // own seller-side directory lookup; this worked example demonstrates
      // only the brand+operator arm because the mock has no account_id index.
      // SWAP: add a `lookupWorkspaceByAccountId(ref.account_id)` upstream
      // call before this branch falls through to brand-domain lookup.
      if ('account_id' in ref) {
        // Mock has no account_id → workspace_id index. Real adapters look up
        // by their own seller-assigned account_id and skip the domain
        // resolver entirely. Until the upstream gains that index, treat as
        // unknown rather than silently fall through.
        return null;
      }
      const advertiserDomain = ref.brand.domain;
      const workspaceId = await upstream.lookupWorkspace(advertiserDomain);
      if (!workspaceId) return null;
      return {
        id: workspaceId,
        name: advertiserDomain,
        status: 'active',
        ctx_metadata: { workspace_id: workspaceId, advertiser_domain: advertiserDomain },
      };
    },
  };

  creative: CreativeBuilderPlatform<CreativeMeta> = defineCreativeBuilderPlatform<CreativeMeta>({
    listCreativeFormats: async (_req, ctx): Promise<ListCreativeFormatsResponse> => {
      // `list_creative_formats` is a no-account tool — `ctx.account` is
      // narrowed to `Account<TCtxMeta> | undefined`. The default
      // listing workspace fallback in `accounts.resolve(undefined)` ensures
      // ctx.account is non-null at runtime; the narrow below converts the
      // framework's type-level invariant into an explicit guard.
      const workspaceId = ctx.account?.ctx_metadata.workspace_id ?? DEFAULT_LISTING_WORKSPACE;
      // SWAP: pull from your platform's global format catalog or the
      // workspace tied to the API key's principal. Mock keys templates
      // per workspace, so we hit a default workspace that has the full set.
      const templates = await upstream.listTemplates(workspaceId);
      return { formats: templates.map(templateToFormat) };
    },

    buildCreative: async (req: BuildCreativeRequest, ctx): Promise<BuildCreativeReturn> => {
      const workspaceId = ctx.account.ctx_metadata.workspace_id;

      // Templates the workspace can render. Used to resolve the AdCP
      // format_id slug → upstream template_id for each requested target.
      const templates = await upstream.listTemplates(workspaceId);
      const slugToTemplate = new Map<string, UpstreamTemplate>(templates.map(t => [templateIdToFormatSlug(t), t]));

      const idempotency = req.idempotency_key ?? randomUUID();
      const inputs = manifestToInputs(req.creative_manifest);

      const buildOne = async (target: { agent_url: string; id: string }, i: number): Promise<CreativeManifest> => {
        const template = slugToTemplate.get(target.id);
        if (!template) {
          throw new AdcpError('INVALID_REQUEST', {
            message: `Unknown target_format_id.id: ${target.id}`,
            field: 'target_format_id',
          });
        }
        const created = await upstream.createRender(workspaceId, {
          template_id: template.template_id,
          inputs,
          mode: 'build',
          client_request_id: `${idempotency}.${i}`,
        });
        const completed = await upstream.waitForRender(workspaceId, created.render_id);
        return projectRenderToManifest(completed, { agent_url: PUBLIC_AGENT_URL, id: target.id });
      };

      // Multi-format request — return `CreativeManifest[]`; framework wraps
      // as `{ creative_manifests: [...] }`. See BuildCreativeReturn (4-arm
      // discriminated union) — returning the wrong arm fails wire-schema
      // validation. SHAPE-GOTCHAS.md §5.
      if (req.target_format_ids && req.target_format_ids.length > 0) {
        return Promise.all(req.target_format_ids.map((t, i) => buildOne(t, i)));
      }

      // Single-format request.
      if (!req.target_format_id) {
        throw new AdcpError('INVALID_REQUEST', {
          message: 'target_format_id or target_format_ids required',
          field: 'target_format_id',
        });
      }
      return buildOne(req.target_format_id, 0);
    },

    previewCreative: async (req: PreviewCreativeRequest, ctx): Promise<PreviewCreativeResponse> => {
      // `preview_creative` is a no-account tool — the wire request schema
      // doesn't carry `account`, so the framework types `ctx.account` as
      // `Account<TCtxMeta> | undefined` per the framework's `NoAccountCtx` narrow.
      // This adapter's `accounts.resolve(undefined)` always returns the
      // default-listing-workspace fallback so ctx.account is non-null at
      // runtime; the defensive narrow below converts the framework's
      // type-level invariant into an explicit guard so a future change
      // to the resolver doesn't silently regress.
      if (!ctx.account) {
        throw new AdcpError('ACCOUNT_NOT_FOUND', {
          message: 'preview_creative requires a resolved account context',
          recovery: 'correctable',
        });
      }
      const workspaceId = ctx.account.ctx_metadata.workspace_id;

      // Spec: `request_type` is the discriminator. The fixture exercises
      // 'single' only; batch + variant are out of scope for this example.
      if (req.request_type !== 'single') {
        throw new AdcpError('UNSUPPORTED_FEATURE', {
          message: `request_type '${req.request_type}' not supported`,
        });
      }
      if (!req.creative_manifest) {
        throw new AdcpError('INVALID_REQUEST', { message: 'creative_manifest required for single preview' });
      }

      // Buyer's manifest carries the input format_id; resolve to upstream.
      const sourceFormatId = req.creative_manifest.format_id.id;
      const templates = await upstream.listTemplates(workspaceId);
      const template = templates.find(t => templateIdToFormatSlug(t) === sourceFormatId);
      if (!template) {
        throw new AdcpError('INVALID_REQUEST', {
          message: `Unknown format_id.id: ${sourceFormatId}`,
          field: 'creative_manifest.format_id',
        });
      }

      const inputs = manifestToInputs(req.creative_manifest);
      const created = await upstream.createRender(workspaceId, {
        template_id: template.template_id,
        inputs,
        mode: 'preview',
      });
      const completed = await upstream.waitForRender(workspaceId, created.render_id);

      const previewUrl = completed.output?.preview_url;
      if (!previewUrl) {
        throw new AdcpError('INVALID_REQUEST', { message: 'upstream returned no preview_url' });
      }

      // PreviewCreativeResponse is a 3-way discriminated union (single |
      // batch | variant). Single mode requires `previews[].renders[]` even
      // for one preview — and each render needs the `output_format`
      // discriminator. urlRender({...}) injects it. SHAPE-GOTCHAS.md §4.
      return {
        response_type: 'single',
        previews: [
          {
            preview_id: `prv_${created.render_id}`,
            renders: [
              urlRender({
                render_id: `rnd_${created.render_id}`,
                preview_url: previewUrl,
                role: 'primary',
                ...(template.dimensions
                  ? { dimensions: { width: template.dimensions.width, height: template.dimensions.height } }
                  : {}),
              }),
            ],
            input: { name: 'default' },
          },
        ],
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      };
    },
  });
}

/** Project an AdCP `creative_manifest.assets` onto upstream `inputs[]`.
 *  The mock-server treats `inputs` as opaque — order is significant for
 *  body fingerprint / idempotency. Production platforms vary; some take a
 *  keyed map, some a positional array. */
function manifestToInputs(manifest: CreativeManifest | undefined): unknown[] {
  if (!manifest) return [];
  return Object.entries(manifest.assets).map(([asset_id, asset]) => ({ asset_id, ...asset }));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const platform = new CreativeTemplateAdapter();
const idempotencyStore = createIdempotencyStore({ backend: memoryBackend(), ttlSeconds: 86_400 });

serve(
  ({ taskStore }) =>
    createAdcpServerFromPlatform(platform, {
      name: 'hello-creative-adapter-template',
      version: '1.0.0',
      taskStore,
      idempotency: idempotencyStore,
      resolveSessionKey: ctx => {
        const acct = ctx.account as Account<CreativeMeta> | undefined;
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

console.log(`creative-template adapter on http://127.0.0.1:${PORT}/mcp · upstream: ${UPSTREAM_URL}`);
