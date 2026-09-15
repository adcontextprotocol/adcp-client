/**
 * decisioning-platform-derived-accounts — reference implementation of
 * `AccountStore.resolution: 'derived'`: an agent fronting an **upstream-managed
 * account namespace**.
 *
 * Use this when the roster is not yours to provision — you proxy a platform
 * that owns it (Meta / Snap business accounts, an audio-generation vendor's
 * workspaces, a retail-media network in proxy mode), or the buyer's credential
 * is bound to exactly one account on your side.
 *
 * Wire contract (corrected in SDK 14 — adcp-client#1647, upstream adcp#5062):
 *   1. Buyer calls `list_accounts` → the accounts that credential can reach.
 *   2. Buyer passes `account: { account_id }` on every account-scoped call.
 *      The `{ brand, operator }` natural-key arm is refused by the framework.
 *   3. `accounts.resolve` verifies the buyer-supplied id against the same
 *      credential-scoped set, and returns `null` on a miss → `ACCOUNT_NOT_FOUND`.
 *   4. Tools with no `account` on the wire (`list_creative_formats`,
 *      `provide_performance_feedback`) auto-select the account when the
 *      credential reaches exactly one; account-required operations return
 *      `ACCOUNT_REQUIRED` when no unique auth-derived selection exists.
 *
 * `createDerivedAccountStore` implements 2–4; the only thing you write is the
 * credential-scoped roster lookup.
 *
 * @see docs/guides/account-resolution.md
 * @see docs/migration-13-to-14.md
 */

import {
  createAdcpServer,
  createDerivedAccountStore,
  createIdempotencyStore,
  serve,
  verifyApiKey,
  type Account,
  type ResolveContext,
} from '@adcp/sdk/server';

const PORT = Number(process.env['PORT'] ?? 3011);
const ADCP_AUTH_TOKEN = process.env['ADCP_AUTH_TOKEN'] ?? 'sk_harness_do_not_use_in_prod';

// ---------------------------------------------------------------------------
// Platform account metadata — replace with your upstream model
// ---------------------------------------------------------------------------

interface UpstreamMeta {
  /** The id this account has on the upstream platform. */
  upstreamId: string;
}

// ---------------------------------------------------------------------------
// The upstream roster.
//
// REPLACE this with a call to the platform you front — e.g.
// `GET /me/adaccounts` with the caller's OAuth token. The shape that matters
// is the scoping: this function answers "what can THIS credential reach?",
// and everything else (id verification, singleton auto-select, list_accounts
// filtering + paging) is derived from its answer. An unscoped roster here is
// a cross-tenant read on every surface at once.
// ---------------------------------------------------------------------------

const UPSTREAM_ROSTER: Record<string, Array<Account<UpstreamMeta>>> = {
  sk_harness_do_not_use_in_prod: [
    {
      id: 'act_1001',
      name: 'Acme — paid social',
      status: 'active',
      brand: { domain: 'acme-corp.example.com' },
      operator: 'pinnacle-media.example.com',
      ctx_metadata: { upstreamId: 'urn:upstream:1001' },
    },
    {
      id: 'act_1002',
      name: 'Acme — retail media',
      status: 'active',
      brand: { domain: 'acme-corp.example.com' },
      operator: 'acme-corp.example.com',
      ctx_metadata: { upstreamId: 'urn:upstream:1002' },
    },
  ],
};

function credentialKey(ctx: ResolveContext | undefined): string | undefined {
  const cred = ctx?.authInfo?.credential;
  if (cred?.kind === 'api_key') return cred.key_id;
  if (cred?.kind === 'oauth') return cred.client_id;
  return undefined;
}

const accounts = createDerivedAccountStore<UpstreamMeta>({
  listAccounts: async ctx => {
    const key = credentialKey(ctx);
    if (key === undefined) return [];
    // ── REPLACE: await myUpstream.accountsFor(ctx?.authInfo) ──
    return UPSTREAM_ROSTER[key] ?? [];
  },
  // Optional: point lookup for rosters too large to enumerate per request.
  // It MUST filter by the caller too — the factory only re-checks that the
  // returned id is the one that was asked for.
  //
  // lookupAccount: async (id, ctx) => myUpstream.accountForCaller(id, ctx?.authInfo),
});

// ---------------------------------------------------------------------------
// AdCP server
// ---------------------------------------------------------------------------

const server = createAdcpServer<UpstreamMeta>({
  name: 'Upstream-Managed Accounts Demo Seller',
  version: '1.0.0',

  accounts,

  // Minimal media-buy surface — replace with your real platform methods.
  mediaBuy: {
    getProducts: async (_req, _ctx) => ({
      products: [
        {
          id: 'prod_social_feed',
          name: 'Social feed inventory',
          product_type: 'display' as const,
          pricing: { model: 'cpm' as const, rate: 8.5, currency: 'USD' },
        },
      ],
    }),

    createMediaBuy: async (req, ctx) => ({
      // ctx.account is the verified upstream account — the buyer's
      // `account_id` was checked against the roster above before this ran.
      media_buy: {
        id: `buy_${Date.now()}`,
        name: req.name,
        status: 'pending_review' as const,
        account: { account_id: ctx.account.id },
        product_id: req.product_id,
        budget: req.budget,
        targeting: req.targeting,
      },
    }),

    updateMediaBuy: async (req, ctx) => ({
      media_buy: {
        id: req.id,
        name: req.name ?? 'Updated Buy',
        status: 'active' as const,
        account: { account_id: ctx.account.id },
        product_id: 'prod_social_feed',
        budget: req.budget ?? { total: 0, currency: 'USD' },
        targeting: req.targeting ?? {},
      },
    }),

    getMediaBuyDelivery: async (_req, _ctx) => {
      const today = new Date().toISOString().split('T')[0] ?? new Date().toISOString();
      return {
        reporting_period: { start: today, end: today },
        currency: 'USD',
        media_buy_deliveries: [],
      };
    },

    getMediaBuys: async (_req, _ctx) => ({ media_buys: [] }),
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
    console.log(`Upstream-managed-accounts seller running on :${PORT}`);
    console.log(`  resolution: 'derived' — buyers call list_accounts, then pass account: { account_id }`);
    console.log(`  auth: Bearer ${ADCP_AUTH_TOKEN}`);
    process.on('SIGTERM', () => stop());
  })
  .catch(err => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
