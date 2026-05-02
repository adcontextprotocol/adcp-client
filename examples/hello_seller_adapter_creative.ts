/**
 * hello_seller_adapter_creative — worked starting point for an AdCP creative
 * adapter that wraps an upstream creative-template platform.
 *
 * Fork this. Replace `upstream.*` with your real backend's HTTP/SDK client.
 * The AdCP-facing platform methods stay the same.
 *
 * Demo:
 *   npx @adcp/sdk@latest mock-server creative-template --port 4151
 *   UPSTREAM_URL=http://127.0.0.1:4151 \
 *     npx tsx examples/hello_seller_adapter_creative.ts
 *   adcp storyboard run http://127.0.0.1:3004/mcp creative_template \
 *     --auth sk_harness_do_not_use_in_prod
 *   curl http://127.0.0.1:4151/_debug/traffic
 *
 * Production:
 *   UPSTREAM_URL=https://my-platform.example/api UPSTREAM_API_KEY=… \
 *     npx tsx examples/hello_seller_adapter_creative.ts
 *
 * creative-template is stateless: build_creative and preview_creative produce
 * manifests on demand; list_creatives is a creative-ad-server tool and is not
 * available here.
 */

import {
  createAdcpServerFromPlatform,
  serve,
  verifyApiKey,
  createIdempotencyStore,
  createUpstreamHttpClient,
  memoryBackend,
  AdcpError,
  BuyerAgentRegistry,
  defineCreativeBuilderPlatform,
  type DecisioningPlatform,
  type AccountStore,
  type Account,
  type BuyerAgent,
  type CachedBuyerAgentRegistry,
  type SyncCreativesRow,
} from '@adcp/sdk/server';
import { displayRender, imageAssetSlot, textAssetSlot, vastAssetSlot, urlAssetSlot, audioAssetSlot } from '@adcp/sdk';
import type { ListCreativeFormatsResponse, Format, CreativeManifest } from '@adcp/sdk/types';
import { createHash, randomUUID } from 'node:crypto';

const UPSTREAM_URL = process.env['UPSTREAM_URL'] ?? 'http://127.0.0.1:4151';
const UPSTREAM_API_KEY = process.env['UPSTREAM_API_KEY'] ?? 'mock_creative_template_key_do_not_use_in_prod';
const PORT = Number(process.env['PORT'] ?? 3004);
const ADCP_AUTH_TOKEN = process.env['ADCP_AUTH_TOKEN'] ?? 'sk_harness_do_not_use_in_prod';
// SWAP: replace with a real workspace ID, or query a global format catalog if
// your platform exposes one without workspace context. The demo workspace ships
// all four seed templates.
const DEMO_WORKSPACE_ID = process.env['DEMO_WORKSPACE_ID'] ?? 'ws_acme_studio';

// ---------------------------------------------------------------------------
// Upstream types — shapes returned by the creative-template HTTP API.
// SWAP: replace with your platform's own API response types.
// ---------------------------------------------------------------------------

interface UpstreamTemplate {
  template_id: string;
  name: string;
  description: string;
  channel: 'display' | 'video' | 'audio' | 'ctv' | 'native';
  dimensions?: { width: number; height: number };
  duration_seconds?: { min: number; max: number };
  output_kind: 'html_tag' | 'javascript_tag' | 'vast_xml';
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
    preview_url?: string;
  };
  error?: { code: string; message: string };
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Upstream HTTP client — SWAP for production.
// Five typed wrappers below are the seams to replace when wiring a real platform.
// ---------------------------------------------------------------------------

const http = createUpstreamHttpClient({
  baseUrl: UPSTREAM_URL,
  auth: { kind: 'static_bearer', token: UPSTREAM_API_KEY },
});

const workspacePath = (workspaceId: string) => `/v3/workspaces/${encodeURIComponent(workspaceId)}`;

const upstream = {
  // SWAP: resolve AdCP account.advertiser → upstream workspace_id.
  // Mock exposes /_lookup/workspace; production uses a directory service
  // or config registry. No auth required — fires before account context.
  async lookupWorkspace(adcpAdvertiser: string): Promise<string | null> {
    const { body } = await http.get<{ workspace_id?: string }>('/_lookup/workspace', {
      adcp_advertiser: adcpAdvertiser,
    });
    return body?.workspace_id ?? null;
  },

  // SWAP: template catalog for format discovery and slot mapping.
  // Real platforms may expose a workspace-scoped or global catalog.
  async listTemplates(workspaceId: string): Promise<UpstreamTemplate[]> {
    const { body } = await http.get<{ templates: UpstreamTemplate[] }>(`${workspacePath(workspaceId)}/templates`);
    return body?.templates ?? [];
  },

  // SWAP: single template lookup. Used to resolve template_id during build.
  async getTemplate(workspaceId: string, templateId: string): Promise<UpstreamTemplate | null> {
    const { body } = await http.get<UpstreamTemplate>(
      `${workspacePath(workspaceId)}/templates/${encodeURIComponent(templateId)}`
    );
    return body;
  },

  // SWAP: submit a render job.
  // Real platforms may accept webhooks instead of polling; see pollRender below.
  async createRender(
    workspaceId: string,
    body: { template_id: string; inputs: unknown[]; mode: 'preview' | 'build'; client_request_id?: string }
  ): Promise<UpstreamRender> {
    const r = await http.post<UpstreamRender>(`${workspacePath(workspaceId)}/renders`, body);
    if (!r.body) {
      throw new AdcpError('UPSTREAM_ERROR', { message: 'Render creation returned no body' });
    }
    return r.body;
  },

  // SWAP: poll render status until terminal or timeout.
  // The mock auto-promotes queued → running → complete across two GETs.
  // Real platforms use webhooks or SSE; replace this loop with your callback.
  async pollRender(workspaceId: string, renderId: string, timeoutMs = 30_000): Promise<UpstreamRender> {
    const deadline = Date.now() + timeoutMs;
    let delay = 300;
    while (Date.now() < deadline) {
      const { body } = await http.get<UpstreamRender>(
        `${workspacePath(workspaceId)}/renders/${encodeURIComponent(renderId)}`
      );
      if (!body) {
        throw new AdcpError('UPSTREAM_ERROR', { message: `Render ${renderId} disappeared` });
      }
      if (body.status === 'complete') return body;
      if (body.status === 'failed') {
        throw new AdcpError('UPSTREAM_ERROR', {
          message: body.error?.message ?? 'Render failed with no message',
        });
      }
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 5_000);
    }
    throw new AdcpError('UPSTREAM_ERROR', {
      message: `Render ${renderId} timed out after ${timeoutMs}ms`,
    });
  },
};

// ---------------------------------------------------------------------------
// Format translation — upstream template → AdCP Format.
//
// The upstream uses `slot_id` (platform vocabulary); AdCP uses `asset_id`
// (format vocabulary). The mapping below is intentionally explicit so adopters
// can see the translation and adjust it for their own slot naming conventions.
// ---------------------------------------------------------------------------

function templateToFormat(t: UpstreamTemplate): Format {
  const dim = t.dimensions;
  const format_id = dim
    ? { agent_url: UPSTREAM_URL, id: t.template_id, width: dim.width, height: dim.height }
    : { agent_url: UPSTREAM_URL, id: t.template_id };

  // SWAP: asset slot mapping — upstream slot_id → AdCP asset_id + type.
  // Production platforms with their own slot registry produce a richer list.
  const assetSlots = t.slots.map(slot => {
    if (slot.asset_type === 'image') {
      return imageAssetSlot({
        asset_id: slot.slot_id,
        required: slot.required,
        ...(slot.constraints as object | undefined),
      });
    }
    if (slot.asset_type === 'video') {
      return vastAssetSlot({ asset_id: slot.slot_id, required: slot.required });
    }
    if (slot.asset_type === 'click_url') {
      return urlAssetSlot({ asset_id: slot.slot_id, required: slot.required });
    }
    if (slot.asset_type === 'audio') {
      return audioAssetSlot({ asset_id: slot.slot_id, required: slot.required });
    }
    // text → text slot
    return textAssetSlot({ asset_id: slot.slot_id, required: slot.required });
  });

  // Renders for display formats with fixed dimensions.
  const renders = dim
    ? [displayRender({ role: 'primary', dimensions: { width: dim.width, height: dim.height } })]
    : undefined;

  return { format_id, name: t.name, description: t.description, assets: assetSlots, renders };
}

// ---------------------------------------------------------------------------
// CreativeManifest projection — upstream render output → AdCP wire shape.
//
// SWAP: the asset_id keys ('ad_tag', 'preview_url') must match the format's
// declared asset_id values above. Adjust to match your format catalog.
// ---------------------------------------------------------------------------

function renderToManifest(render: UpstreamRender): CreativeManifest {
  const format_id = { agent_url: UPSTREAM_URL, id: render.template_id };
  const output = render.output ?? {};
  const previewAsset = output.preview_url
    ? { preview_url: { asset_type: 'url' as const, url: output.preview_url, url_type: 'clickthrough' as const } }
    : {};

  if (output.vast_xml) {
    return {
      format_id,
      assets: { ad_tag: { asset_type: 'vast', delivery_type: 'inline', content: output.vast_xml }, ...previewAsset },
    };
  }
  if (output.tag_javascript) {
    return {
      format_id,
      assets: { ad_tag: { asset_type: 'javascript', content: output.tag_javascript }, ...previewAsset },
    };
  }
  return {
    format_id,
    assets: { ad_tag: { asset_type: 'html', content: output.tag_html ?? '' }, ...previewAsset },
  };
}

// ---------------------------------------------------------------------------
// Buyer-agent registry — the same pattern used across all seller adapters.
// SWAP: replace the in-memory map with your onboarding ledger DB query.
// See hello_seller_adapter_signal_marketplace.ts for the full setup comment.
// ---------------------------------------------------------------------------

function hashApiKey(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32);
}

const ONBOARDING_LEDGER = new Map<string, BuyerAgent>([
  [
    hashApiKey(ADCP_AUTH_TOKEN),
    {
      agent_url: 'https://addie.example.com',
      display_name: 'Addie (storyboard runner)',
      status: 'active',
      billing_capabilities: new Set(['operator']),
      sandbox_only: true,
    },
  ],
]);

const agentRegistry: CachedBuyerAgentRegistry = BuyerAgentRegistry.cached(
  BuyerAgentRegistry.bearerOnly({
    resolveByCredential: async credential => {
      if (credential.kind !== 'api_key') return null;
      return ONBOARDING_LEDGER.get(credential.key_id) ?? null;
    },
  }),
  { ttlSeconds: 60 }
);

// ---------------------------------------------------------------------------
// In-memory creative store — for syncCreatives.
// SWAP: replace with your CMS / DAM DB table.
// ---------------------------------------------------------------------------

interface StoredCreative {
  creative_id: string;
  name: string;
  status: 'approved' | 'pending_review';
  stored_at: string;
}

const creativeStore = new Map<string, StoredCreative>();

// ---------------------------------------------------------------------------
// Workspace metadata — threaded through ctx.account.ctx_metadata.
// ---------------------------------------------------------------------------

interface WorkspaceMeta {
  workspace_id: string;
}

// ---------------------------------------------------------------------------
// AdCP platform adapter — typed against CreativeBuilderPlatform.
// ---------------------------------------------------------------------------

class CreativeTemplateAdapter implements DecisioningPlatform<Record<string, never>, WorkspaceMeta> {
  capabilities = {
    specialisms: ['creative-template'] as const,
    config: {},
  };

  agentRegistry = agentRegistry;

  accounts: AccountStore<WorkspaceMeta> = {
    // SWAP: resolve AdCP account.advertiser → upstream workspace_id.
    // creative-template uses account.advertiser (brand domain) as the tenant key,
    // not account.operator. Adjust the field read for your platform's tenant model.
    resolve: async (ref, ctx) => {
      const adcpAdvertiser = (ref as { advertiser?: string })?.advertiser;
      if (!adcpAdvertiser) return null;
      void ctx?.agent; // optional: gate on agent.allowed_brands here
      const workspaceId = await upstream.lookupWorkspace(adcpAdvertiser);
      if (!workspaceId) return null;
      return {
        id: workspaceId,
        name: adcpAdvertiser,
        status: 'active',
        advertiser: adcpAdvertiser,
        ctx_metadata: { workspace_id: workspaceId },
        // FIXME(adopter): replace with your real sandbox flag from backing store.
        sandbox: true,
      };
    },
  };

  creative = defineCreativeBuilderPlatform<WorkspaceMeta>({
    // build_creative — the core tool.
    //
    // Dispatch: extract target_format_id.id as the upstream template_id,
    // submit a render job, poll until terminal, project output → CreativeManifest.
    //
    // SWAP: replace the inputs extraction below with your platform's slot mapping.
    // The mock server accepts any array; real platforms validate slot_id values.
    buildCreative: async (req, ctx) => {
      const workspaceId = ctx.account.ctx_metadata.workspace_id;
      // target_format_id.id carries the upstream template_id.
      // Multi-format requests (target_format_ids) are handled below.
      const templateIds = req.target_format_ids
        ? req.target_format_ids.map(f => f.id)
        : req.target_format_id
          ? [req.target_format_id.id]
          : [];

      if (templateIds.length === 0) {
        throw new AdcpError('INVALID_REQUEST', {
          message: 'target_format_id or target_format_ids is required',
          field: 'target_format_id',
        });
      }

      // SWAP: build the inputs array from req.creative_manifest.assets or req.message.
      // The mock server accepts an empty inputs array for the demo path.
      const inputs: unknown[] = [];
      if (req.creative_manifest?.assets) {
        for (const [slotId, asset] of Object.entries(req.creative_manifest.assets)) {
          if (asset) inputs.push({ slot_id: slotId, asset });
        }
      }

      // The framework validates idempotency_key presence on mutating tools before
      // reaching this handler. The randomUUID() fallback covers the rare case where
      // the framework passes through without validation (e.g. test harness without
      // idempotency enforcement). Production adopters SHOULD assert the key is present.
      const idempotency = req.idempotency_key ?? randomUUID();

      if (templateIds.length === 1) {
        const [templateId] = templateIds;
        const render = await upstream.createRender(workspaceId, {
          template_id: templateId,
          inputs,
          mode: 'build',
          client_request_id: idempotency,
        });
        const complete = await upstream.pollRender(workspaceId, render.render_id);
        return renderToManifest(complete);
      }

      // Multi-format path — produce one manifest per format.
      const manifests = await Promise.all(
        templateIds.map(async (templateId, i) => {
          const render = await upstream.createRender(workspaceId, {
            template_id: templateId,
            inputs,
            mode: 'build',
            client_request_id: `${idempotency}.${i}`,
          });
          return upstream.pollRender(workspaceId, render.render_id).then(renderToManifest);
        })
      );
      return manifests;
    },

    // preview_creative — sandbox-URL or inline HTML preview, sync.
    //
    // SWAP: replace the template_id extraction with your preview rendering path.
    // Real DCO platforms generate a render variant per preview_inputs[]; the
    // mock produces one render per POST, so this collapses to a single variant.
    previewCreative: async (req, ctx) => {
      const workspaceId = ctx.account.ctx_metadata.workspace_id;
      const templateId = req.template_id ?? req.creative_manifest?.format_id?.id ?? req.format_id?.id;
      if (!templateId) {
        throw new AdcpError('INVALID_REQUEST', {
          message: 'template_id or creative_manifest.format_id.id required for preview',
          field: 'template_id',
        });
      }
      const render = await upstream.createRender(workspaceId, {
        template_id: templateId,
        inputs: [],
        mode: 'preview',
        client_request_id: randomUUID(),
      });
      const complete = await upstream.pollRender(workspaceId, render.render_id);
      const previewUrl = complete.output?.preview_url ?? `${UPSTREAM_URL}/preview/${render.render_id}`;

      return {
        response_type: 'single',
        // SWAP: set expires_at to however long your preview URLs remain valid.
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        previews: [
          {
            preview_id: render.render_id,
            renders: [
              { render_id: render.render_id, output_format: 'url' as const, preview_url: previewUrl, role: 'primary' },
            ],
            input: { name: 'preview', macros: {} },
          },
        ],
        sandbox: true,
      };
    },

    // sync_creatives — creative review. Stateless platforms auto-approve.
    // SWAP: replace with your CMS upsert + review pipeline.
    syncCreatives: async (creatives, _ctx) => {
      const rows: SyncCreativesRow[] = creatives.map(c => {
        creativeStore.set(c.creative_id, {
          creative_id: c.creative_id,
          name: c.name ?? c.creative_id,
          status: 'approved',
          stored_at: new Date().toISOString(),
        });
        return { creative_id: c.creative_id, status: 'approved' as const };
      });
      return rows;
    },
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const platform = new CreativeTemplateAdapter();
const idempotencyStore = createIdempotencyStore({ backend: memoryBackend(), ttlSeconds: 86_400 });

serve(
  ({ taskStore }) =>
    createAdcpServerFromPlatform(platform, {
      name: 'hello-seller-adapter-creative',
      version: '1.0.0',
      taskStore,
      idempotency: idempotencyStore,
      resolveSessionKey: ctx => {
        const acct = ctx.account as Account<WorkspaceMeta> | undefined;
        return acct?.id ?? 'anonymous';
      },
      // list_creative_formats workaround — not yet on CreativeBuilderPlatform.
      // Move listCreativeFormats into defineCreativeBuilderPlatform({}) once
      // PR #1331 merges (adds listCreativeFormats? to the v6 typed interface).
      creative: {
        listCreativeFormats: async _params => {
          // SWAP: replace with a fetch from your platform's global format catalog.
          // The mock server exposes a workspace-scoped catalog; the demo workspace
          // (DEMO_WORKSPACE_ID) is used here as the format authority. Production
          // platforms typically expose a global catalog without account context.
          const templates = await upstream.listTemplates(DEMO_WORKSPACE_ID);
          const formats = templates.map(templateToFormat);
          return { formats, sandbox: true } satisfies ListCreativeFormatsResponse;
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

console.log(`creative adapter on http://127.0.0.1:${PORT}/mcp · upstream: ${UPSTREAM_URL}`);
