/**
 * decisioning-platform-implicit-accounts — reference implementation showing
 * `AccountStore.resolution: 'implicit'` wired through `createAdcpServer`.
 *
 * Use this when buyers must call `sync_accounts` before any tool — LinkedIn,
 * some retail-media operators, and multi-brand programmatic platforms follow
 * this pattern. The platform does NOT read `ext.account_ref` from tool requests;
 * it resolves the account entirely from the caller's auth credential.
 *
 * Wire contract:
 *   1. Buyer calls `sync_accounts` → `accounts.upsert()` stores the linkage.
 *   2. Buyer calls `create_media_buy` (no ext.account_ref) →
 *      `accounts.resolve(undefined, ctx)` looks up by auth principal.
 *   3. If no prior sync: `ACCOUNT_NOT_FOUND` (not `AUTH_REQUIRED`).
 *
 * @see docs/guides/account-resolution.md
 */

import {
  createAdcpServer,
  serve,
  verifyApiKey,
  createIdempotencyStore,
  InMemoryImplicitAccountStore,
  AdcpError,
  type Account,
} from '@adcp/sdk/server';

const PORT = Number(process.env['PORT'] ?? 3010);
const ADCP_AUTH_TOKEN = process.env['ADCP_AUTH_TOKEN'] ?? 'sk_harness_do_not_use_in_prod';

// ---------------------------------------------------------------------------
// Platform account metadata — replace with your upstream model
// ---------------------------------------------------------------------------

interface PlatformMeta {
  platformAccountId: string;
  tier: 'standard' | 'premium';
}

// ---------------------------------------------------------------------------
// Implicit account store
//
// Stores the `authPrincipal → Account` mapping created by sync_accounts.
// `buildAccount` is the seam to your real platform: call your account-lookup
// or account-creation API here; the in-memory store handles the mapping.
// ---------------------------------------------------------------------------

const accountStore = new InMemoryImplicitAccountStore<PlatformMeta>({
  buildAccount: async (ref, ctx) => {
    const r = ref as Record<string, unknown>;
    const brand = r['brand'] as Record<string, unknown> | undefined;
    const operator = (r['operator'] as string | undefined) ?? '';
    const accountId = (r['account_id'] as string | undefined) ?? `${brand?.['domain'] ?? 'unknown'}:${operator}`;

    // ── REPLACE: call your upstream platform to find or create the account ──
    // const upstream = await myPlatform.findOrCreate({ brand, operator, authInfo: ctx?.authInfo });
    // return { id: upstream.id, name: upstream.name, status: upstream.status, ctx_metadata: ... };

    const account: Account<PlatformMeta> = {
      id: accountId,
      name: operator ? `${operator} (${brand?.['domain'] ?? accountId})` : accountId,
      status: 'active',
      ...(brand && { brand: brand as Account['brand'] }),
      ...(operator && { operator }),
      ctx_metadata: {
        platformAccountId: accountId,
        tier: 'standard',
      },
    };
    return account;
  },
  // Optional: override key derivation (default uses credential.client_id / key_id / agent_url)
  // keyFn: authInfo => authInfo.extra?.tenant_id as string,
  ttlMs: 86_400_000, // 24h — align with your token/session lifetime
});

// ---------------------------------------------------------------------------
// AdCP server
// ---------------------------------------------------------------------------

const server = createAdcpServer<PlatformMeta>({
  name: 'Implicit-Accounts Demo Seller',
  version: '1.0.0',

  accounts: accountStore,

  // Minimal media-buy surface — replace with your real platform methods.
  mediaBuy: {
    getProducts: async (_req, ctx) => {
      return {
        products: [
          {
            id: 'prod_display',
            name: 'Display Inventory',
            product_type: 'display' as const,
            pricing: { model: 'cpm' as const, rate: 5.0, currency: 'USD' },
          },
        ],
      };
    },

    createMediaBuy: async (req, ctx) => {
      // ctx.account is resolved via implicit lookup — no ext.account_ref needed.
      const acctId = ctx.account.id;
      const buyId = `buy_${Date.now()}`;
      return {
        media_buy: {
          id: buyId,
          name: req.name,
          status: 'pending_review' as const,
          account: { account_id: acctId },
          product_id: req.product_id,
          budget: req.budget,
          targeting: req.targeting,
        },
      };
    },

    updateMediaBuy: async (req, ctx) => {
      return {
        media_buy: {
          id: req.id,
          name: req.name ?? 'Updated Buy',
          status: 'active' as const,
          account: { account_id: ctx.account.id },
          product_id: 'prod_display',
          budget: req.budget ?? { total: 0, currency: 'USD' },
          targeting: req.targeting ?? {},
        },
      };
    },

    getMediaBuyDelivery: async (_req, _ctx) => {
      const today = new Date().toISOString().split('T')[0] ?? new Date().toISOString();
      return {
        reporting_period: { start: today, end: today },
        currency: 'USD',
        media_buy_deliveries: [],
      };
    },

    getMediaBuys: async (_req, ctx) => {
      return { media_buys: [] };
    },
  },
});

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

serve({
  servers: [server],
  port: PORT,
  authenticate: verifyApiKey(ADCP_AUTH_TOKEN),
  idempotency: createIdempotencyStore(),
})
  .then(({ stop }) => {
    console.log(`Implicit-accounts seller running on :${PORT}`);
    console.log(`  resolution: 'implicit' — buyers must call sync_accounts first`);
    console.log(`  auth: Bearer ${ADCP_AUTH_TOKEN}`);
    process.on('SIGTERM', () => stop());
  })
  .catch(err => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
