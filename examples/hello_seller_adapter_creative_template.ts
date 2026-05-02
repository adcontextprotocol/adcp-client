/**
 * hello_seller_adapter_creative_template — worked starting point for an
 * AdCP creative-template adapter that wraps an upstream creative-management
 * platform (Celtra-style: workspace → templates → render).
 *
 * Fork this. Replace `UpstreamClient` with your real backend's HTTP/SDK
 * client. The AdCP-facing platform methods stay the same.
 *
 * Demo:
 *   npx @adcp/sdk@latest mock-server creative-template --port 4250
 *   UPSTREAM_URL=http://127.0.0.1:4250 \
 *     npx tsx examples/hello_seller_adapter_creative_template.ts
 *   adcp storyboard run http://127.0.0.1:3002/mcp creative_template \
 *     --auth sk_harness_do_not_use_in_prod
 *   curl http://127.0.0.1:4250/_debug/traffic
 *
 * Production:
 *   UPSTREAM_URL=https://my-creative-platform.example/api \
 *   UPSTREAM_API_KEY=$REAL_KEY \
 *     npx tsx examples/hello_seller_adapter_creative_template.ts
 */

import {
  createAdcpServerFromPlatform,
  serve,
  verifyApiKey,
  createIdempotencyStore,
  memoryBackend,
  AdcpError,
  defineCreativeBuilderPlatform,
  type DecisioningPlatform,
  type CreativeBuilderPlatform,
  type AccountStore,
  type Account,
} from '@adcp/sdk/server';
import type {
  BuildCreativeRequest,
  PreviewCreativeRequest,
  PreviewCreativeResponse,
  CreativeManifest,
} from '@adcp/sdk/types';
import { randomUUID } from 'node:crypto';

const UPSTREAM_URL = process.env['UPSTREAM_URL'] ?? 'http://127.0.0.1:4250';
const UPSTREAM_API_KEY = process.env['UPSTREAM_API_KEY'] ?? 'mock_creative_template_key_do_not_use_in_prod';
const PORT = Number(process.env['PORT'] ?? 3002);
const ADCP_AUTH_TOKEN = process.env['ADCP_AUTH_TOKEN'] ?? 'sk_harness_do_not_use_in_prod';

// ---------------------------------------------------------------------------
// Upstream client — SWAP for production.
// ---------------------------------------------------------------------------

interface UpstreamTemplate {
  template_id: string;
  name: string;
  description: string;
  channel: 'display' | 'video' | 'audio' | 'ctv' | 'native';
  dimensions?: { width: number; height: number };
  duration_seconds?: { min: number; max: number };
  output_kind: 'html_tag' | 'javascript_tag' | 'vast_xml';
  slots: Array<{ slot_id: string; asset_type: string; required: boolean }>;
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
}

class UpstreamClient {
  constructor(private readonly baseUrl: string, private readonly apiKey: string) {}

  /** Generic JSON request. SWAP if your backend uses an SDK or different auth. */
  private async httpJson<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<{ status: number; body: T | null }> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, init);
    if (res.status === 404) return { status: 404, body: null };
    if (!res.ok) throw new Error(`upstream ${method} ${path} → ${res.status}`);
    return { status: res.status, body: (await res.json()) as T };
  }

  // SWAP: workspace lookup. Mock exposes /_lookup; production typically a
  // directory service or config registry.
  async lookupWorkspace(adcpAdvertiser: string): Promise<string | null> {
    const r = await this.httpJson<{ workspace_id?: string }>('GET', '/_lookup/workspace', {
      query: { adcp_advertiser: adcpAdvertiser },
    });
    return r.body?.workspace_id ?? null;
  }

  // SWAP: list templates available in the workspace.
  async listTemplates(workspaceId: string): Promise<UpstreamTemplate[]> {
    const r = await this.httpJson<{ templates: UpstreamTemplate[] }>(
      'GET',
      `/v3/workspaces/${encodeURIComponent(workspaceId)}/templates`,
    );
    return r.body?.templates ?? [];
  }

  // SWAP: create a render (mode = 'build' or 'preview'). Returns 202 with
  // status: 'queued' — poll until 'complete'.
  async createRender(
    workspaceId: string,
    body: { template_id: string; inputs: unknown[]; mode: 'build' | 'preview'; client_request_id: string },
  ): Promise<UpstreamRender> {
    const r = await this.httpJson<UpstreamRender>(
      'POST',
      `/v3/workspaces/${encodeURIComponent(workspaceId)}/renders`,
      { body },
    );
    if (!r.body) {
      throw new AdcpError('INVALID_REQUEST', { message: 'render creation failed' });
    }
    return r.body;
  }

  // SWAP: poll render status. Mock auto-advances queued → running →
  // complete on successive GETs; production platforms typically poll on
  // a webhook or with longer GET cadence.
  async getRender(workspaceId: string, renderId: string): Promise<UpstreamRender | null> {
    const r = await this.httpJson<UpstreamRender>(
      'GET',
      `/v3/workspaces/${encodeURIComponent(workspaceId)}/renders/${encodeURIComponent(renderId)}`,
    );
    return r.body;
  }

  /** Render-and-wait — POST + poll until complete. */
  async renderAndWait(
    workspaceId: string,
    body: { template_id: string; inputs: unknown[]; mode: 'build' | 'preview'; client_request_id: string },
    maxPolls = 5,
  ): Promise<UpstreamRender> {
    let render = await this.createRender(workspaceId, body);
    for (let i = 0; i < maxPolls && render.status !== 'complete' && render.status !== 'failed'; i++) {
      const next = await this.getRender(workspaceId, render.render_id);
      if (!next) throw new AdcpError('INVALID_REQUEST', { message: 'render disappeared mid-poll' });
      render = next;
    }
    if (render.status !== 'complete') {
      throw new AdcpError('SERVICE_UNAVAILABLE', {
        message: `render did not complete (status=${render.status})`,
      });
    }
    return render;
  }
}

// ---------------------------------------------------------------------------
// AdCP-side adapter
// ---------------------------------------------------------------------------

interface WorkspaceMeta {
  workspace_id: string;
  [key: string]: unknown;
}

const upstream = new UpstreamClient(UPSTREAM_URL, UPSTREAM_API_KEY);

/** Map an upstream render's output into a CreativeManifest. The asset_type
 *  discriminator on each slot picks the asset variant; we use html / vast /
 *  preview-url depending on the template's output_kind. */
function toCreativeManifest(
  formatId: string,
  render: UpstreamRender,
): CreativeManifest {
  const out = render.output ?? {};
  const assets: CreativeManifest['assets'] = {};
  if (out.tag_html) {
    assets['tag'] = { asset_type: 'html', content: out.tag_html };
  } else if (out.tag_javascript) {
    assets['tag'] = { asset_type: 'javascript', content: out.tag_javascript };
  } else if (out.vast_xml) {
    // VASTAsset expects an embedded delivery shape — `delivery_type: 'inline'`
    // + `content`, OR `delivery_type: 'redirect'` + `vast_url`. The
    // discriminator picks which.
    assets['tag'] = { asset_type: 'vast', delivery_type: 'inline', content: out.vast_xml };
  }
  if (out.preview_url) {
    assets['preview_url'] = { asset_type: 'url', url: out.preview_url };
  }
  return {
    format_id: { agent_url: `http://127.0.0.1:${PORT}`, id: formatId },
    assets,
  };
}

class CreativeTemplateAdapter implements DecisioningPlatform<Record<string, never>, WorkspaceMeta> {
  capabilities = {
    specialisms: ['creative-template'] as const,
    creative_agents: [] as const,
    channels: [] as const,
    pricingModels: [] as const,
    config: {},
  };

  accounts: AccountStore<WorkspaceMeta> = {
    resolve: async (ref, ctx) => {
      // Creative-template adapters typically receive `account.advertiser`
      // (the brand whose creative is being built). The mock's lookup uses
      // `adcp_advertiser`; production may differ.
      const adcpAdvertiser =
        (ref as { brand?: { domain?: string } })?.brand?.domain ??
        (ref as { advertiser?: string })?.advertiser;
      if (!adcpAdvertiser) return null;
      const workspaceId = await upstream.lookupWorkspace(adcpAdvertiser);
      if (!workspaceId) return null;
      return {
        id: workspaceId,
        name: adcpAdvertiser,
        status: 'active',
        ...(typeof adcpAdvertiser === 'string' ? { brand: { domain: adcpAdvertiser } } : {}),
        ctx_metadata: { workspace_id: workspaceId },
        authInfo: ctx?.authInfo ?? { principal: 'anonymous' },
      } as Account<WorkspaceMeta>;
    },
  };

  creative: CreativeBuilderPlatform<WorkspaceMeta> = defineCreativeBuilderPlatform<WorkspaceMeta>({
    buildCreative: async (req: BuildCreativeRequest, ctx) => {
      const workspaceId = ctx.account.ctx_metadata.workspace_id;
      const templateId = (req.creative_manifest?.format_id?.id ?? req.creative_id) as string | undefined;
      if (!templateId) {
        throw new AdcpError('INVALID_REQUEST', {
          message: 'template_id (via creative_manifest.format_id.id) is required',
          field: 'creative_manifest',
        });
      }
      // Verify the template exists + is visible to this workspace before
      // rendering. listTemplates is also our headline traffic-counter
      // exercise per validate-with-mock-fixtures.
      const templates = await upstream.listTemplates(workspaceId);
      if (!templates.some(t => t.template_id === templateId)) {
        throw new AdcpError('INVALID_REQUEST', {
          message: `template ${templateId} not visible to workspace`,
          field: 'creative_manifest',
        });
      }
      // Pass the assets through as inputs. Real adapters would translate
      // AdCP asset shapes (image_url, headline text, click_url) into the
      // upstream's slot vocabulary; for the mock the shape is permissive.
      const inputs = Object.entries(req.creative_manifest?.assets ?? {}).map(([slot_id, asset]) => ({
        slot_id,
        asset,
      }));
      const render = await upstream.renderAndWait(workspaceId, {
        template_id: templateId,
        inputs,
        mode: 'build',
        client_request_id: req.idempotency_key ?? randomUUID(),
      });
      return toCreativeManifest(templateId, render);
    },

    previewCreative: async (
      req: PreviewCreativeRequest,
      ctx,
    ): Promise<PreviewCreativeResponse> => {
      const workspaceId = ctx.account.ctx_metadata.workspace_id;
      const templateId = (req.creative_manifest?.format_id?.id ?? req.creative_id) as string | undefined;
      if (!templateId) {
        throw new AdcpError('INVALID_REQUEST', {
          message: 'template_id is required',
          field: 'creative_manifest',
        });
      }
      const inputs = Object.entries(req.creative_manifest?.assets ?? {}).map(([slot_id, asset]) => ({
        slot_id,
        asset,
      }));
      const render = await upstream.renderAndWait(workspaceId, {
        template_id: templateId,
        inputs,
        mode: 'preview',
        client_request_id: randomUUID(),
      });
      const previewUrl = render.output?.preview_url ?? `http://127.0.0.1:${PORT}/preview/${render.render_id}`;
      // PreviewCreativeResponse is a discriminated union — `response_type:
      // 'single'` requires `previews[]` with `preview_id` + `renders[]` +
      // `input` per variant. Schema is in tools.generated.ts; storyboards
      // grade per variant, so even single-preview responses must use the
      // array shape.
      return {
        response_type: 'single' as const,
        previews: [
          {
            preview_id: `prv_${render.render_id}`,
            renders: [
              {
                render_id: `rnd_${render.render_id}`,
                output_format: 'url' as const,
                preview_url: previewUrl,
                role: 'primary',
              },
            ],
            input: { name: 'default' },
          },
        ],
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      };
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
      name: 'hello-seller-adapter-creative-template',
      version: '1.0.0',
      taskStore,
      idempotency: idempotencyStore,
      resolveSessionKey: ctx => {
        const acct = ctx.account as Account<WorkspaceMeta> | undefined;
        return acct?.id ?? 'anonymous';
      },
    }),
  {
    port: PORT,
    authenticate: verifyApiKey({
      keys: { [ADCP_AUTH_TOKEN]: { principal: 'compliance-runner' } },
    }),
  },
);

console.log(
  `creative-template adapter on http://127.0.0.1:${PORT}/mcp · upstream: ${UPSTREAM_URL}`,
);
