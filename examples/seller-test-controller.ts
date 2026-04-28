/**
 * Example: seller with `comply_test_controller` wired against typed domain
 * state via `registerTestController` + a hand-rolled `TestControllerStore`.
 *
 * This is what a real seller writes — roughly 250 LOC, not 10. The shape
 * matters. Production tools (`create_media_buy`, `get_media_buy`,
 * `sync_creatives`, `sync_plans`) read from typed domain records with
 * packages, revision numbers, history, currency, and audit trail. Seed
 * handlers MUST write into those same records or subsequent storyboard
 * steps silently see empty state.
 *
 * Read this alongside `examples/comply-controller-seller.ts`. That example
 * uses `createComplyController` — an adapter surface where each scenario
 * maps cleanly to one repository method. Pick this pattern when your
 * media buy / creative records carry internal structure (packages,
 * revision, history) that `seed_*` must populate AND `get_*` must read.
 *
 * Run with:
 *
 *     ADCP_SANDBOX=1 npx tsx examples/seller-test-controller.ts
 */

import {
  CONTROLLER_SCENARIOS,
  createSeedFixtureCache,
  enforceMapCap,
  registerTestController,
  TestControllerError,
  type CreativeStatus,
  type MediaBuyStatus,
  type TestControllerStore,
  type TestControllerStoreFactory,
} from '@adcp/sdk/testing';
import { createTaskCapableServer, serve, type ServeContext } from '@adcp/sdk';

// ---------------------------------------------------------------------------
// Typed domain state.
//
// This is the shape your production handlers already read from. The test
// controller's job is to populate and mutate these same records — NOT a
// parallel bag of seed Maps the rest of your code doesn't know about.
// ---------------------------------------------------------------------------

interface Package {
  package_id: string;
  product_id: string;
  budget: { amount: number; currency: string };
}

interface HistoryEntry {
  at: string;
  by: string;
  from: MediaBuyStatus;
  to: MediaBuyStatus;
  reason?: string;
}

interface MediaBuyState {
  media_buy_id: string;
  status: MediaBuyStatus;
  packages: Package[];
  currency: string;
  revision: number;
  history: HistoryEntry[];
  canceled_at?: string;
  canceled_by?: string;
  rejection_reason?: string;
}

interface CreativeState {
  creative_id: string;
  format_id: string;
  status: CreativeStatus;
  synced_at: string;
  manifest?: Record<string, unknown>;
  pricing_option_id?: string;
  rejection_reason?: string;
}

interface Session {
  session_id: string;
  mediaBuys: Map<string, MediaBuyState>;
  creatives: Map<string, CreativeState>;
}

// ---------------------------------------------------------------------------
// Session persistence. Real sellers swap this for Postgres / Redis / a
// JSONB blob on a row they already own. The in-memory `sessions` map below
// is example scaffolding — it's bounded so a misbehaving client can't grow
// it without bound, and it fails fast when NODE_ENV=production.
// ---------------------------------------------------------------------------

if (process.env.NODE_ENV === 'production') {
  throw new Error(
    'seller-test-controller.ts is an in-memory example. Replace `sessions` + `loadOrCreateSession` ' +
      'with your real persistence layer before running in production.'
  );
}

const SESSION_CAP = 256;
const sessions = new Map<string, Session>();

function loadOrCreateSession(sessionId: string): Session {
  let session = sessions.get(sessionId);
  if (!session) {
    enforceMapCap(sessions, sessionId, 'sessions', SESSION_CAP);
    session = { session_id: sessionId, mediaBuys: new Map(), creatives: new Map() };
    sessions.set(sessionId, session);
  }
  return session;
}

/**
 * Pull a session id out of the request context.
 *
 * `context.session_id` is NOT a spec field — `core/context.json` defines
 * `context` as opaque correlation data that agents must echo unchanged.
 * Sellers who want session-scoped fixtures pick their own convention: a
 * field on `context`, an auth-resolved tenant id, the MCP session header,
 * etc. This example reads `context.session_id` because it's the simplest
 * hook for a storyboard runner to populate. Swap it for whatever your
 * auth layer already gives you.
 */
function resolveSessionId(input: Record<string, unknown>): string {
  const context = input.context as { session_id?: string } | undefined;
  return context?.session_id ?? 'example-default';
}

// ---------------------------------------------------------------------------
// State-machine guards live HERE, in the same module your production tools
// import. The controller routes through the same guards — one source of
// truth for what transitions are legal. The tables cover every state in
// the AdCP 3.0.0 status enums; TypeScript will catch a missing state if
// you swap the `Partial<Record<...>>` signature for `Record<...>`.
// ---------------------------------------------------------------------------

const MEDIA_BUY_TRANSITIONS: Record<MediaBuyStatus, MediaBuyStatus[]> = {
  pending_creatives: ['pending_start', 'active', 'paused', 'rejected', 'canceled'],
  pending_start: ['active', 'paused', 'canceled'],
  active: ['paused', 'completed', 'canceled'],
  paused: ['active', 'completed', 'canceled'],
  completed: [],
  rejected: [],
  canceled: [],
};

const CREATIVE_TRANSITIONS: Record<CreativeStatus, CreativeStatus[]> = {
  processing: ['pending_review', 'approved', 'rejected', 'archived'],
  pending_review: ['approved', 'rejected', 'archived'],
  approved: ['rejected', 'archived'],
  rejected: ['approved', 'archived'],
  archived: [],
};

function assertMediaBuyTransition(from: MediaBuyStatus, to: MediaBuyStatus): void {
  if (!MEDIA_BUY_TRANSITIONS[from].includes(to)) {
    throw new TestControllerError('INVALID_TRANSITION', `media buy cannot move from ${from} to ${to}`, from);
  }
}

function assertCreativeTransition(from: CreativeStatus, to: CreativeStatus): void {
  if (!CREATIVE_TRANSITIONS[from].includes(to)) {
    throw new TestControllerError('INVALID_TRANSITION', `creative cannot move from ${from} to ${to}`, from);
  }
}

// ---------------------------------------------------------------------------
// Per-request store factory.
//
// `scenarios` is advertised statically so `list_scenarios` never triggers
// session load. `createStore` runs per non-probe request and closes over
// the live session, so every handler mutation lands in `sessions` and is
// visible to the next call — including the seller's production readers.
//
// Seed handlers short-circuit on `has(id)`: the SDK's `SeedFixtureCache`
// already enforced fixture-equivalence at the dispatcher layer, so a
// re-seed call reaching the handler is a confirmed replay. Overwriting
// would clobber `revision` / `history` that `force_*` subsequently built
// up, which defeats the point of re-seed being idempotent.
// ---------------------------------------------------------------------------

const CONTROLLER_ACTOR = 'test-controller';

const storeFactory: TestControllerStoreFactory = {
  scenarios: [CONTROLLER_SCENARIOS.FORCE_MEDIA_BUY_STATUS, CONTROLLER_SCENARIOS.FORCE_CREATIVE_STATUS],

  createStore(input): TestControllerStore {
    const session = loadOrCreateSession(resolveSessionId(input));

    return {
      seedMediaBuy(mediaBuyId, fixture) {
        if (session.mediaBuys.has(mediaBuyId)) return Promise.resolve();
        enforceMapCap(session.mediaBuys, mediaBuyId, 'media buys');
        const raw = (fixture ?? {}) as Record<string, unknown>;
        session.mediaBuys.set(mediaBuyId, {
          media_buy_id: mediaBuyId,
          status: isMediaBuyStatus(raw.status) ? raw.status : 'pending_creatives',
          packages: Array.isArray(raw.packages) ? (raw.packages as Package[]) : [],
          currency: typeof raw.currency === 'string' ? raw.currency : 'USD',
          revision: 0,
          history: [],
        });
        return Promise.resolve();
      },

      seedCreative(creativeId, fixture) {
        if (session.creatives.has(creativeId)) return Promise.resolve();
        enforceMapCap(session.creatives, creativeId, 'creatives');
        const raw = (fixture ?? {}) as Record<string, unknown>;
        session.creatives.set(creativeId, {
          creative_id: creativeId,
          format_id: typeof raw.format_id === 'string' ? raw.format_id : 'display_300x250',
          status: isCreativeStatus(raw.status) ? raw.status : 'processing',
          synced_at: new Date().toISOString(),
          manifest: (raw.manifest as Record<string, unknown> | undefined) ?? undefined,
          pricing_option_id: typeof raw.pricing_option_id === 'string' ? raw.pricing_option_id : undefined,
        });
        return Promise.resolve();
      },

      async forceMediaBuyStatus(mediaBuyId, status, rejectionReason) {
        const record = session.mediaBuys.get(mediaBuyId);
        if (!record) {
          throw new TestControllerError(
            'NOT_FOUND',
            `force_media_buy_status: ${mediaBuyId} not found — seed it first with seed_media_buy`
          );
        }
        assertMediaBuyTransition(record.status, status);
        const previous = record.status;
        record.status = status;
        record.revision += 1;
        record.history.push({
          at: new Date().toISOString(),
          by: CONTROLLER_ACTOR,
          from: previous,
          to: status,
          reason: rejectionReason,
        });
        if (status === 'canceled') {
          record.canceled_at = new Date().toISOString();
          record.canceled_by = CONTROLLER_ACTOR;
        }
        if (status === 'rejected' && rejectionReason) {
          record.rejection_reason = rejectionReason;
        }
        return { success: true, previous_state: previous, current_state: status };
      },

      async forceCreativeStatus(creativeId, status, rejectionReason) {
        const record = session.creatives.get(creativeId);
        if (!record) {
          throw new TestControllerError(
            'NOT_FOUND',
            `force_creative_status: ${creativeId} not found — seed it first with seed_creative`
          );
        }
        assertCreativeTransition(record.status, status);
        const previous = record.status;
        record.status = status;
        if (status === 'rejected' && rejectionReason) {
          record.rejection_reason = rejectionReason;
        } else {
          delete record.rejection_reason;
        }
        return { success: true, previous_state: previous, current_state: status };
      },
    };
  },
};

function isMediaBuyStatus(value: unknown): value is MediaBuyStatus {
  return typeof value === 'string' && value in MEDIA_BUY_TRANSITIONS;
}

function isCreativeStatus(value: unknown): value is CreativeStatus {
  return typeof value === 'string' && value in CREATIVE_TRANSITIONS;
}

// ---------------------------------------------------------------------------
// Serve. `registerTestController` itself does NOT enforce per-request
// sandbox gating — once registered, any authenticated caller can reach
// the tool. The gate at registration site below ensures the tool isn't
// even advertised in `list_tools` when `ADCP_SANDBOX` is unset. If your
// server fronts both sandbox and prod traffic on the same port, use
// `createComplyController` (exposes a `sandboxGate` callback) or wrap
// `handleTestControllerRequest` with your own per-request check.
//
// SECURITY: an env var is NOT an authority boundary. Operators who set
// `ADCP_SANDBOX=1` in production by accident (bad .env, k8s ConfigMap
// typo) would expose the controller to every caller and let them mutate
// real media buys / creatives / accounts. This example refuses to run
// that combination — belt-and-suspenders. For real mixed-traffic
// deployments, front the sandbox on a separate port behind separate
// auth.
// ---------------------------------------------------------------------------

if (process.env.ADCP_SANDBOX === '1' && process.env.NODE_ENV === 'production') {
  throw new Error(
    'seller-test-controller.ts refuses to expose comply_test_controller in production (NODE_ENV=production + ADCP_SANDBOX=1). ' +
      'An env var is not an authority boundary — front the sandbox on a separate port behind separate auth before relying on this gate in prod.'
  );
}

const seedCache = createSeedFixtureCache();

function createAgentServer({ taskStore }: ServeContext) {
  const server = createTaskCapableServer('example-typed-seller', '0.1.0', { taskStore });
  // Register your production tools here: get_products, create_media_buy,
  // get_media_buy, sync_creatives, … each reads from `session.mediaBuys`
  // and `session.creatives`, so anything seeded above is immediately
  // visible. Omitted for brevity.
  if (process.env.ADCP_SANDBOX === '1') {
    registerTestController(server, storeFactory, { seedCache });
  }
  return server;
}

serve(createAgentServer, { port: 3457 });
console.log('example-typed-seller listening on :3457 (ADCP_SANDBOX=%s)', process.env.ADCP_SANDBOX ?? '');
