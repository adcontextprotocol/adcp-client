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
  assertNoExampleTlds,
  type DecisioningPlatform,
  type CreativeBuilderPlatform,
  type LegacyBuildCreativeReturn,
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
  buildCreativeReturn,
  previewCreative,
  type CanonicalFormatKind,
} from '@adcp/sdk';
import type {
  Format,
  ListCreativeFormatsResponse,
  BuildCreativeRequest,
  CreativeManifest,
  PreviewCreativeRequest,
  PreviewCreativeResponse,
} from '@adcp/sdk/types';
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
assertNoExampleTlds(
  { DEFAULT_LISTING_WORKSPACE, PUBLIC_AGENT_URL },
  { allowIn: ['test', 'development'], checklistPath: 'examples/hello_creative_adapter_template.ts' }
);

type SupportedFormat = NonNullable<
  NonNullable<import('@adcp/sdk').GetAdCPCapabilitiesResponse['creative']>['supported_formats']
>[number];

/** Stable public routes backed by the upstream template catalog. The mock
 * workspace exposes this exact set; production adapters generate the same
 * configuration from their deployed template registry. */
const SUPPORTED_FORMATS: SupportedFormat[] = [
  {
    capability_id: 'display_300x250',
    format: {
      format_kind: 'image',
      params: {
        width: 300,
        height: 250,
        slots: [{ asset_group_id: 'serving_tag', asset_type: 'html', required: true }],
      },
      display_name: 'Display 300x250 template',
    },
    operations: ['build', 'preview'],
  },
  {
    capability_id: 'display_728x90',
    format: {
      format_kind: 'image',
      params: {
        width: 728,
        height: 90,
        slots: [{ asset_group_id: 'serving_tag', asset_type: 'javascript', required: true }],
      },
      display_name: 'Display 728x90 template',
    },
    operations: ['build', 'preview'],
  },
  {
    capability_id: 'display_320x50',
    format: {
      format_kind: 'image',
      params: {
        width: 320,
        height: 50,
        slots: [{ asset_group_id: 'serving_tag', asset_type: 'javascript', required: true }],
      },
      display_name: 'Display 320x50 template',
    },
    operations: ['build', 'preview'],
  },
  {
    capability_id: 'video_15s',
    format: {
      format_kind: 'video_vast',
      params: {
        duration_ms_exact: 15_000,
      },
      display_name: 'Video preroll 15s template',
    },
    operations: ['build', 'preview'],
  },
  {
    capability_id: 'audio_30s',
    format: {
      format_kind: 'audio_hosted',
      params: {
        duration_ms_exact: 30_000,
        asset_source: 'seller_pre_rendered_from_brief',
        buyer_asset_acceptance: 'rejected',
      },
      display_name: 'Audio 30s synthesis template',
    },
    operations: ['build', 'preview'],
  },
];

function supportedFormat(capabilityId: string): SupportedFormat | undefined {
  return SUPPORTED_FORMATS.find(entry => entry.capability_id === capabilityId);
}

function capabilityForOperation(
  capabilityId: string,
  operation: 'build' | 'preview',
  field: 'target_capability_id' | 'target_capability_ids'
): SupportedFormat {
  const capability = supportedFormat(capabilityId);
  if (!capability || !capability.operations?.includes(operation)) {
    throw new AdcpError('FORMAT_NOT_SUPPORTED', {
      message: `Creative capability '${capabilityId}' does not advertise the ${operation} operation`,
      field,
      details: {
        supported_capability_ids: SUPPORTED_FORMATS.filter(entry => entry.operations?.includes(operation)).map(
          entry => entry.capability_id
        ),
      },
    });
  }
  return capability;
}

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

/** Output asset slot. The format's `assets[]` mixes input slots (image,
 *  headline, script — what the buyer provides) with the build_creative
 *  output slot (`serving_tag` — what the adapter returns). Per
 *  creative-manifest.json:14 every key in `creative_manifest.assets` MUST
 *  match a declared `assets[].asset_id`; without the output slot here, our
 *  build_creative response's `serving_tag` would key against an undeclared
 *  slot. `required: false` because the buyer doesn't supply this — the
 *  adapter generates it. asset_type is driven by upstream `output_kind` so
 *  the discriminator in the response (html / javascript / vast / audio)
 *  matches the slot the buyer can resolve from `get_format`. */
function outputSlot(t: UpstreamTemplate) {
  switch (t.output_kind) {
    case 'html_tag':
      return FormatAsset.html({ asset_id: 'serving_tag', required: false });
    case 'javascript_tag':
      return FormatAsset.javascript({ asset_id: 'serving_tag', required: false });
    case 'vast_xml':
      return FormatAsset.vast({ asset_id: 'serving_tag', required: false });
    case 'audio_url':
      return FormatAsset.audio({ asset_id: 'serving_tag', required: false });
    default: {
      // Exhaustiveness gate. If `output_kind` grows a fifth case (image_url,
      // daast_xml, etc.) the unreachable assertion fires at compile time so
      // adopters extending the upstream type can't ship a silent `undefined`
      // entry into format.assets[].
      const exhaustive: never = t.output_kind;
      throw new Error(`unhandled output_kind: ${exhaustive as string}`);
    }
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
    // Input slots (what the buyer provides) + the output slot (what the
    // adapter generates and returns via build_creative).
    assets: [...t.slots.map(projectSlot), outputSlot(t)],
  };
}

/** Project an upstream `render.output` onto AdCP `creative_manifest.assets`.
 *  The mock returns one of four output shapes (HTML tag, JS tag, VAST, audio
 *  URL); AdCP creative-manifest assets are keyed by asset_id and discriminated
 *  by asset_type. Use the `htmlAsset` / `javascriptAsset` / `audioAsset`
 *  builders to inject the discriminator — a bare `{ content }` or `{ url }`
 *  fails the asset-union oneOf.
 *
 *  The `serving_tag` asset_id matches the output slot declared by
 *  `outputSlot(t)` in `templateToFormat`, satisfying creative-manifest.json:14
 *  ("each key MUST match an asset_id from the format's assets array"). All
 *  four output kinds (HTML / JS / VAST / audio) key under the same id; the
 *  asset_type discriminator on the value picks the matching slot's typed
 *  branch. */
type ManifestFormatIdentity =
  | { format_id: { agent_url: string; id: string }; format_kind?: never }
  | { format_kind: CanonicalFormatKind; format_id?: never };

function projectRenderToManifest(render: UpstreamRender, formatIdentity: ManifestFormatIdentity): CreativeManifest {
  const out = render.output ?? {};
  const assets: CreativeManifest['assets'] = {};
  const canonical = 'format_kind' in formatIdentity;
  if (out.tag_html) {
    assets['serving_tag'] = htmlAsset({ content: out.tag_html });
  } else if (out.tag_javascript) {
    assets['serving_tag'] = javascriptAsset({ content: out.tag_javascript });
  } else if (out.vast_xml) {
    // Canonical video_vast declares the normative `vast_tag` slot and returns
    // an inline VAST asset. The legacy named-format path retains its historical
    // `serving_tag` HTML projection so 3.0/3.1 callers continue to receive an
    // asset matching list_creative_formats.
    assets[canonical ? 'vast_tag' : 'serving_tag'] = canonical
      ? { asset_type: 'vast', delivery_type: 'inline', content: out.vast_xml }
      : htmlAsset({ content: out.vast_xml });
  } else if (out.audio_url) {
    // Audio templates render to a hosted MP3. Real audio platforms return
    // signed CDN URLs with TTL — the buyer must fetch within the lifetime.
    // The `audioAsset` builder injects the `asset_type: 'audio'` discriminator
    // that the AdCP creative-manifest oneOf requires. Reuses the same
    // `serving_tag` asset_id as the HTML / JS / VAST branches — the asset_type
    // discriminator is what the buyer keys on, not the asset_id.
    assets[canonical ? 'audio_main' : 'serving_tag'] = audioAsset({ url: out.audio_url });
  }
  return { ...formatIdentity, assets };
}

class CreativeTemplateAdapter implements DecisioningPlatform<Record<string, never>, CreativeMeta> {
  capabilities = {
    specialisms: ['creative-template'] as const,
    overrides: {
      creative: {
        supported_formats: SUPPORTED_FORMATS,
        bills_through_adcp: false,
        canonical_catalog_version: '3.2.0',
      },
    },
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
    listCreativeFormatsLegacy: async (_req, ctx): Promise<ListCreativeFormatsResponse> => {
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
      return { status: 'completed', formats: templates.map(templateToFormat) };
    },

    buildCreativeLegacy: async (req: BuildCreativeRequest, ctx): Promise<LegacyBuildCreativeReturn> => {
      const workspaceId = ctx.account.ctx_metadata.workspace_id;

      // Templates the workspace can render. Used to resolve the AdCP
      // format_id slug → upstream template_id for each requested target.
      const templates = await upstream.listTemplates(workspaceId);
      const slugToTemplate = new Map<string, UpstreamTemplate>(templates.map(t => [templateIdToFormatSlug(t), t]));

      const idempotency = req.idempotency_key ?? randomUUID();
      const inputs = manifestToInputs(req.creative_manifest);

      const buildOne = async (
        targetId: string,
        formatIdentity: ManifestFormatIdentity,
        i: number,
        selectorField: 'target_capability_id' | 'target_capability_ids' | 'target_format_id' | 'target_format_ids'
      ): Promise<CreativeManifest> => {
        const template = slugToTemplate.get(targetId);
        if (!template) {
          throw new AdcpError('FORMAT_NOT_SUPPORTED', {
            message: `Unknown creative target: ${targetId}`,
            field: selectorField,
          });
        }
        const created = await upstream.createRender(workspaceId, {
          template_id: template.template_id,
          inputs,
          mode: 'build',
          client_request_id: `${idempotency}.${i}`,
        });
        const completed = await upstream.waitForRender(workspaceId, created.render_id);
        return projectRenderToManifest(completed, formatIdentity);
      };

      // `buildCreativeReturn.multi(...)` / `.single(...)` pin which arm of
      // the 4-shape `BuildCreativeReturn` union you're emitting. The framework
      // wraps `multi` into `{ creative_manifests: [...] }` and `single` into
      // `{ creative_manifest: <obj> }` on the wire. SHAPE-GOTCHAS §5.
      if (req.target_capability_ids && req.target_capability_ids.length > 0) {
        const manifests = await Promise.all(
          req.target_capability_ids.map((capabilityId, i) => {
            const capability = capabilityForOperation(capabilityId, 'build', 'target_capability_ids');
            return buildOne(capabilityId, { format_kind: capability.format.format_kind }, i, 'target_capability_ids');
          })
        );
        return buildCreativeReturn.multi(manifests);
      }

      if (req.target_capability_id) {
        const capability = capabilityForOperation(req.target_capability_id, 'build', 'target_capability_id');
        return buildCreativeReturn.single(
          await buildOne(
            req.target_capability_id,
            { format_kind: capability.format.format_kind },
            0,
            'target_capability_id'
          )
        );
      }

      if (req.target_format_ids && req.target_format_ids.length > 0) {
        const manifests = await Promise.all(
          req.target_format_ids.map((target, i) => buildOne(target.id, { format_id: target }, i, 'target_format_ids'))
        );
        return buildCreativeReturn.multi(manifests);
      }

      // Single-format request.
      if (!req.target_format_id) {
        throw new AdcpError('INVALID_REQUEST', {
          message: 'target_format_id or target_format_ids required',
          field: 'target_format_id',
        });
      }
      return buildCreativeReturn.single(
        await buildOne(req.target_format_id.id, { format_id: req.target_format_id }, 0, 'target_format_id')
      );
    },

    previewCreativeLegacy: async (req: PreviewCreativeRequest, ctx): Promise<PreviewCreativeResponse> => {
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
      // Resolve the canonical and legacy selectors independently. Canonical
      // targets must be advertised with `preview`; legacy named formats keep
      // their deprecated top-level `format_id` route and error attribution.
      let sourceFormatId: string;
      let sourceIsCanonical = false;
      if (req.target_capability_id) {
        capabilityForOperation(req.target_capability_id, 'preview', 'target_capability_id');
        sourceFormatId = req.target_capability_id;
        sourceIsCanonical = true;
      } else if (req.format_id?.id) {
        sourceFormatId = req.format_id.id;
      } else if (req.creative_manifest.format_id?.id) {
        // SDK 12/13 and the published 3.1 creative-template storyboard used
        // the manifest's named format as the renderer route when the optional
        // top-level format_id was absent. Keep that compatibility path while
        // preferring the explicit top-level selector above.
        sourceFormatId = req.creative_manifest.format_id.id;
      } else {
        const manifestKind = req.creative_manifest.format_kind;
        let candidates = SUPPORTED_FORMATS.filter(
          capability => capability.operations?.includes('preview') && capability.format.format_kind === manifestKind
        );

        // Three display renderers share the image canonical. Dimensions are
        // sufficient to select one only when they produce exactly one match.
        if (manifestKind === 'image') {
          const imageSlot = req.creative_manifest.assets['image'];
          const image = Array.isArray(imageSlot) ? imageSlot[0] : imageSlot;
          const width = image && typeof image === 'object' && image.asset_type === 'image' ? image.width : undefined;
          const height = image && typeof image === 'object' && image.asset_type === 'image' ? image.height : undefined;
          if (typeof width === 'number' && typeof height === 'number') {
            candidates = candidates.filter(
              capability =>
                'width' in capability.format.params &&
                'height' in capability.format.params &&
                capability.format.params.width === width &&
                capability.format.params.height === height
            );
          }
        }

        const inferredCapability = candidates[0];
        if (candidates.length !== 1 || !inferredCapability?.capability_id) {
          throw new AdcpError('FORMAT_NOT_SUPPORTED', {
            message: `Canonical preview inference found ${candidates.length} compatible advertised capabilities`,
            field: 'target_capability_id',
            details: { supported_capability_ids: candidates.map(capability => capability.capability_id) },
          });
        }
        sourceFormatId = inferredCapability.capability_id;
        sourceIsCanonical = true;
      }

      const templates = await upstream.listTemplates(workspaceId);
      const template = templates.find(t => templateIdToFormatSlug(t) === sourceFormatId);
      if (!template) {
        throw new AdcpError('FORMAT_NOT_SUPPORTED', {
          message: `Unknown ${sourceIsCanonical ? 'target_capability_id' : 'format_id.id'}: ${sourceFormatId}`,
          field: sourceIsCanonical ? 'target_capability_id' : 'format_id',
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

      // `previewCreative.single({...})` injects
      // `response_type: 'single'`. The render slot's `output_format`
      // discriminator is in turn injected by `urlRender({...})`.
      // SHAPE-GOTCHAS §4.
      return {
        status: 'completed' as const,
        ...previewCreative.single({
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
        }),
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
  return Object.entries(manifest.assets).map(([asset_id, asset]) =>
    Array.isArray(asset)
      ? { asset_id, assets: asset }
      : asset !== null && typeof asset === 'object'
        ? {
            asset_id,
            ...asset,
          }
        : { asset_id, asset }
  );
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
