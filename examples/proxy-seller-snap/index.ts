/**
 * proxy-seller-snap — fork target for proxy-shaped sellers whose AdCP read
 * path fronts an upstream ads platform instead of a seller-owned datastore.
 *
 * Snap is the concrete shape because it is representative: account resolution
 * maps the buyer's AdCP account to a Snap ad account, read handlers call a
 * Snap-shaped client, and `TestControllerBridge` makes storyboard-seeded
 * fixtures visible on sandbox reads without pretending the adapter's live
 * upstream path is healthy.
 *
 * FORK CHECKLIST
 *   1. Replace `emptySnapClient` with your real upstream OAuth/API client.
 *   2. Replace `resolveSnapAccount` with your production account resolver.
 *   3. Keep `bridgeFromSessionStore` keyed on resolved `ctx.account`.
 *   4. Register `comply_test_controller` only in sandbox/conformance hosts.
 *   5. Add a live-OAuth sandbox runner that proves adapter health without
 *      relying on `_bridge`-augmented fixtures.
 *
 * Run locally:
 *
 *   ADCP_SANDBOX=1 npx tsx examples/proxy-seller-snap/index.ts
 *   adcp call http://127.0.0.1:3018/mcp get_products \
 *     '{"buying_mode":"brief","brief":"outdoor apparel","account":{"account_id":"snap_sandbox_acme","sandbox":true}}' \
 *     --auth sk_snap_proxy_harness_do_not_use_in_prod
 */

import { z } from 'zod';
import { createAdcpServer } from '@adcp/sdk/server/legacy/v5';
import {
  AdcpError,
  bridgeFromSessionStore,
  InMemoryStateStore,
  serve,
  verifyApiKey,
  type SeededCreative,
  type TestControllerBridge,
} from '@adcp/sdk/server';
import { createComplyController } from '@adcp/sdk/testing';
import type { AccountReference, GetProductsResponse, PropertyList } from '@adcp/sdk/types';

type ValidationMode = 'strict' | 'warn' | 'off';
type Product = NonNullable<GetProductsResponse['products']>[number];

const PORT = Number(process.env['PORT'] ?? 3018);
const ADCP_AUTH_TOKEN = process.env['ADCP_AUTH_TOKEN'] ?? 'sk_snap_proxy_harness_do_not_use_in_prod';
const PUBLIC_AGENT_URL = process.env['PUBLIC_AGENT_URL'] ?? `http://127.0.0.1:${PORT}`;
const DEFAULT_SANDBOX_ACCOUNT_ID = 'snap_sandbox_acme';

interface SnapAccount {
  id: string;
  name: string;
  status: 'active' | 'pending_approval' | 'rejected' | 'payment_required' | 'suspended' | 'closed';
  sandbox?: boolean;
  mode?: 'sandbox' | 'live';
  brand?: { domain: string };
  operator?: string;
  ctx_metadata: {
    snap_ad_account_id: string;
    bridge_session_id: string;
  };
}

interface SnapBridgeSession {
  seededProducts: Map<string, Record<string, unknown>>;
  seededCreatives: SeededCreative[];
  seededPropertyLists: PropertyList[];
}

export interface SnapClient {
  listProducts(adAccountId: string): Promise<Product[]>;
  listCreatives(adAccountId: string): Promise<SeededCreative[]>;
  listPropertyLists(adAccountId: string): Promise<PropertyList[]>;
}

export class InMemorySnapSessionStore {
  private readonly sessions = new Map<string, SnapBridgeSession>();

  loadForAccount(account: SnapAccount): SnapBridgeSession {
    return this.load(account.ctx_metadata.bridge_session_id);
  }

  load(sessionId: string): SnapBridgeSession {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { seededProducts: new Map(), seededCreatives: [], seededPropertyLists: [] };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  loadForControllerInput(input: Record<string, unknown>): SnapBridgeSession {
    const accountId = readAccountId(input) ?? DEFAULT_SANDBOX_ACCOUNT_ID;
    return this.load(`snap:${accountId}`);
  }
}

export function createInMemorySnapSessionStore(): InMemorySnapSessionStore {
  return new InMemorySnapSessionStore();
}

const emptySnapClient: SnapClient = {
  // SWAP: production calls Snap Marketing API product/catalog endpoints.
  async listProducts() {
    return [];
  },
  // SWAP: production calls Snap creative library endpoints.
  async listCreatives() {
    return [];
  },
  // SWAP: production calls the upstream governance/list surface you proxy.
  async listPropertyLists() {
    return [];
  },
};

// SWAP: production resolves the buyer principal + AccountReference through
// your account directory or upstream OAuth `/me/adaccounts` equivalent.
function resolveSnapAccount(ref: AccountReference): SnapAccount | null {
  if ('account_id' in ref) {
    if (!ref.account_id) return null;
    const sandbox = ref.account_id.startsWith('snap_sandbox_');
    return {
      id: ref.account_id,
      name: sandbox ? 'Snap sandbox advertiser' : 'Snap advertiser',
      status: 'active',
      sandbox,
      mode: sandbox ? 'sandbox' : 'live',
      ctx_metadata: {
        snap_ad_account_id: ref.account_id.replace(/^snap_/, ''),
        bridge_session_id: `snap:${ref.account_id}`,
      },
    };
  }

  const domain = ref.brand.domain;
  if (!domain) return null;
  const sandbox = domain.endsWith('.sandbox');
  return {
    id: sandbox ? DEFAULT_SANDBOX_ACCOUNT_ID : `snap_${domain.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`,
    name: `Snap advertiser for ${domain}`,
    status: 'active',
    sandbox,
    mode: sandbox ? 'sandbox' : 'live',
    brand: { domain },
    ...(ref.operator !== undefined && { operator: ref.operator }),
    ctx_metadata: {
      snap_ad_account_id: sandbox ? 'sandbox_acme' : domain,
      bridge_session_id: `snap:${sandbox ? DEFAULT_SANDBOX_ACCOUNT_ID : domain}`,
    },
  };
}

function requireResolvedAccount(account: SnapAccount | undefined): SnapAccount {
  if (!account) {
    throw new Error('TestControllerBridge requires resolveAccount; no resolved Snap account was available');
  }
  return account;
}

function readAccountId(input: Record<string, unknown>): string | undefined {
  const account = input['account'];
  if (!account || typeof account !== 'object') return undefined;
  const accountId = (account as { account_id?: unknown }).account_id;
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined;
}

function makeSnapBridge(sessionStore: InMemorySnapSessionStore): TestControllerBridge<SnapAccount> {
  return bridgeFromSessionStore<SnapBridgeSession, SnapAccount>({
    loadSession: (_input, ctx) => sessionStore.loadForAccount(requireResolvedAccount(ctx.account)),
    selectSeededProducts: session => session.seededProducts,
    selectSeededCreatives: session => session.seededCreatives,
    selectSeededPropertyLists: session => session.seededPropertyLists,
    productDefaults: {
      name: 'Seeded Snap storyboard product',
      description: 'Storyboard fixture merged by TestControllerBridge for wire conformance.',
      publisher_properties: [{ publisher_domain: 'snap.com', selection_type: 'all' }],
      channels: ['social'],
      delivery_type: 'non_guaranteed',
      format_ids: [{ agent_url: PUBLIC_AGENT_URL, id: 'snap-single-image' }],
      pricing_options: [
        {
          pricing_option_id: 'snap-cpm-floor',
          pricing_model: 'cpm',
          currency: 'USD',
          floor_price: 5,
        },
      ],
      reporting_capabilities: {
        available_reporting_frequencies: ['daily'],
        expected_delay_minutes: 60,
        timezone: 'UTC',
        supports_webhooks: false,
        available_metrics: ['impressions', 'clicks', 'spend'],
        date_range_support: 'date_range',
      },
    },
  });
}

export interface CreateProxySellerSnapServerOptions {
  snapClient?: SnapClient;
  sessionStore?: InMemorySnapSessionStore;
  enableComplyTestController?: boolean;
  validation?: {
    requests?: ValidationMode;
    responses?: ValidationMode;
  };
}

export function createProxySellerSnapServer(options: CreateProxySellerSnapServerOptions = {}) {
  const snapClient = options.snapClient ?? emptySnapClient;
  const sessionStore = options.sessionStore ?? createInMemorySnapSessionStore();

  const server = createAdcpServer<SnapAccount>({
    name: 'proxy-seller-snap',
    version: '1.0.0',
    stateStore: new InMemoryStateStore(),
    validation: options.validation ?? { requests: 'warn', responses: 'strict' },
    resolveAccount: async ref => resolveSnapAccount(ref),
    resolveSessionKey: ctx => ctx.account?.id ?? 'snap-anonymous',
    mediaBuy: {
      getProducts: async (_req, ctx) => ({
        products: await snapClient.listProducts(requireResolvedAccount(ctx.account).ctx_metadata.snap_ad_account_id),
        cache_scope: 'account',
      }),
    },
    creative: {
      listCreatives: async (_req, ctx) => {
        const creatives = await snapClient.listCreatives(
          requireResolvedAccount(ctx.account).ctx_metadata.snap_ad_account_id
        );
        return {
          query_summary: { total_matching: creatives.length, returned: creatives.length },
          pagination: { limit: 50, offset: 0, has_more: false },
          creatives,
        };
      },
    },
    governance: {
      listPropertyLists: async (_req, ctx) => {
        const lists = await snapClient.listPropertyLists(
          requireResolvedAccount(ctx.account).ctx_metadata.snap_ad_account_id
        );
        return {
          lists,
          pagination: { has_more: false },
        };
      },
      getPropertyList: async (req, ctx) => {
        const lists = await snapClient.listPropertyLists(
          requireResolvedAccount(ctx.account).ctx_metadata.snap_ad_account_id
        );
        const list = lists.find(entry => entry.list_id === req.list_id);
        if (!list) {
          throw new AdcpError('REFERENCE_NOT_FOUND', {
            message: 'Property list not found',
            field: 'list_id',
          });
        }
        return {
          list,
          identifiers: [],
          pagination: { has_more: false },
        };
      },
    },
    testController: makeSnapBridge(sessionStore),
  });

  if (options.enableComplyTestController) {
    createComplyController({
      sandboxGate: input =>
        process.env['ADCP_SANDBOX'] === '1' || readAccountId(input)?.startsWith('snap_sandbox_') === true,
      inputSchema: {
        account: z
          .object({ account_id: z.string().optional(), sandbox: z.boolean().optional() })
          .passthrough()
          .optional(),
      },
      seed: {
        product: ({ product_id, fixture }, ctx) => {
          sessionStore.loadForControllerInput(ctx.input).seededProducts.set(product_id, fixture);
        },
        creative: ({ creative_id, fixture }, ctx) => {
          const session = sessionStore.loadForControllerInput(ctx.input);
          const withoutExisting = session.seededCreatives.filter(c => c.creative_id !== creative_id);
          session.seededCreatives = [
            ...withoutExisting,
            {
              creative_id,
              name: typeof fixture['name'] === 'string' ? fixture['name'] : `Seeded Snap creative ${creative_id}`,
              format_id: { agent_url: PUBLIC_AGENT_URL, id: 'snap-single-image' },
              status: readCreativeStatus(fixture['status']),
              created_date: new Date().toISOString(),
              updated_date: new Date().toISOString(),
            } as SeededCreative,
          ];
        },
      },
    }).register(server);
  }

  return server;
}

function readCreativeStatus(value: unknown): SeededCreative['status'] {
  return value === 'approved' || value === 'pending_review' || value === 'rejected' || value === 'archived'
    ? value
    : 'pending_review';
}

if (require.main === module) {
  serve(() => createProxySellerSnapServer({ enableComplyTestController: process.env['ADCP_SANDBOX'] === '1' }), {
    port: PORT,
    authenticate: verifyApiKey({
      keys: { [ADCP_AUTH_TOKEN]: { principal: 'snap-proxy-harness' } },
    }),
  });

  console.log(`proxy-seller-snap on http://127.0.0.1:${PORT}/mcp`);
}
