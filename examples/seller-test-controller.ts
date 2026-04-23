/**
 * Example: seller with `comply_test_controller` wired against typed domain
 * state via `registerTestController` + a hand-rolled `TestControllerStore`.
 *
 * This is what a real seller writes — roughly 200 LOC, not 10. The shape
 * matters. Production tools (`create_media_buy`, `get_media_buy`,
 * `sync_creatives`, `sync_plans`) read from typed domain records with
 * packages, revision numbers, history, currency, and audit trail. Seed
 * handlers MUST write into those same records or subsequent storyboard
 * steps silently see empty state.
 *
 * Read this alongside `examples/comply-controller-seller.ts`. That example
 * uses `createComplyController` — an adapter surface that assumes each
 * scenario maps cleanly to one repository method. Use it when your
 * domain state is simple. Use the pattern in this file when:
 *
 *   - Your media buy / creative records carry non-trivial internal
 *     structure (packages, history, committed_by, revision tracking).
 *   - `seed_*` needs to populate the same structures that `get_*` reads.
 *   - You want session-scoped state (one session per request, loaded
 *     from your persistence layer) without a module-level Map.
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
  type TestControllerStore,
  type TestControllerStoreFactory,
} from '@adcp/client/testing';
import { createTaskCapableServer, serve } from '@adcp/client';
import type { CreativeStatus, MediaBuyStatus } from '@adcp/client';

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
// Session persistence. In a real seller this is Postgres / Redis / JSONB
// blob on a row you already own. Keep the surface small: load + save.
// ---------------------------------------------------------------------------

const sessions = new Map<string, Session>();

function loadSession(sessionId: string): Session {
  let session = sessions.get(sessionId);
  if (!session) {
    session = { session_id: sessionId, mediaBuys: new Map(), creatives: new Map() };
    sessions.set(sessionId, session);
  }
  return session;
}

function resolveSessionId(input: Record<string, unknown>): string {
  const context = input.context as { session_id?: string } | undefined;
  return context?.session_id ?? 'default';
}

// ---------------------------------------------------------------------------
// State-machine guards live HERE, in the same module your production tools
// import. The controller routes through the same guards — one source of
// truth for what transitions are legal. In a real seller this file would
// be `state-machines.ts` and be imported by both paths.
// ---------------------------------------------------------------------------

const MEDIA_BUY_TRANSITIONS: Partial<Record<MediaBuyStatus, MediaBuyStatus[]>> = {
  pending_creatives: ['active', 'paused', 'canceled'],
  active: ['paused', 'completed', 'canceled'],
  paused: ['active', 'canceled'],
  completed: [],
  canceled: [],
};

function assertMediaBuyTransition(from: MediaBuyStatus, to: MediaBuyStatus): void {
  const allowed = MEDIA_BUY_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new TestControllerError('INVALID_TRANSITION', `media buy cannot move from ${from} to ${to}`, from);
  }
}

// ---------------------------------------------------------------------------
// Per-request store factory.
//
// `scenarios` is advertised statically so `list_scenarios` never triggers
// session load. `createStore` runs per non-probe request and closes over
// the live session, so every handler mutation lands in `sessions` and is
// visible to the next call — including the seller's production readers.
// ---------------------------------------------------------------------------

const CONTROLLER_ACTOR = 'comply_test_controller';

const storeFactory: TestControllerStoreFactory = {
  scenarios: [
    CONTROLLER_SCENARIOS.FORCE_MEDIA_BUY_STATUS,
    CONTROLLER_SCENARIOS.FORCE_CREATIVE_STATUS,
  ],

  createStore(input): TestControllerStore {
    const session = loadSession(resolveSessionId(input));

    return {
      seedMediaBuy(mediaBuyId, fixture) {
        const raw = (fixture ?? {}) as Partial<MediaBuyState>;
        enforceMapCap(session.mediaBuys, mediaBuyId, 'media buys');
        session.mediaBuys.set(mediaBuyId, {
          media_buy_id: mediaBuyId,
          status: raw.status ?? 'pending_creatives',
          packages: raw.packages ?? [],
          currency: raw.currency ?? 'USD',
          revision: 0,
          history: [],
        });
        return Promise.resolve();
      },

      seedCreative(creativeId, fixture) {
        const raw = (fixture ?? {}) as Partial<CreativeState>;
        enforceMapCap(session.creatives, creativeId, 'creatives');
        session.creatives.set(creativeId, {
          creative_id: creativeId,
          format_id: raw.format_id ?? 'display_300x250',
          status: raw.status ?? 'processing',
          synced_at: new Date().toISOString(),
          manifest: raw.manifest,
          pricing_option_id: raw.pricing_option_id,
        });
        return Promise.resolve();
      },

      async forceMediaBuyStatus(mediaBuyId, status, rejectionReason) {
        const record = session.mediaBuys.get(mediaBuyId);
        if (!record) {
          throw new TestControllerError(
            'NOT_FOUND',
            `media buy ${mediaBuyId} not found — seed it first with seed_media_buy`
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
        if (rejectionReason) record.rejection_reason = rejectionReason;
        return { success: true, previous_state: previous, current_state: status };
      },

      async forceCreativeStatus(creativeId, status, rejectionReason) {
        const record = session.creatives.get(creativeId);
        if (!record) {
          throw new TestControllerError(
            'NOT_FOUND',
            `creative ${creativeId} not found — seed it first with seed_creative`
          );
        }
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

// ---------------------------------------------------------------------------
// Serve. One shared seed-idempotency cache across requests so the spec's
// "same id + equivalent fixture = existing" rule holds for storyboard
// replays.
// ---------------------------------------------------------------------------

const seedCache = createSeedFixtureCache();

function createAgentServer() {
  const server = createTaskCapableServer({ name: 'example-typed-seller', version: '0.1.0' });
  // Register production tools here: get_products, create_media_buy,
  // get_media_buy, sync_creatives, … each reads from `session.mediaBuys`
  // and `session.creatives`, so anything seeded above is immediately
  // visible. Omitted for brevity.
  registerTestController(server, storeFactory, { seedCache });
  return server;
}

if (process.env.ADCP_SANDBOX !== '1') {
  console.error(
    'Refusing to start: set ADCP_SANDBOX=1 to run this example. ' +
      'The comply_test_controller tool must never be registered in production.'
  );
  process.exit(1);
}

serve(createAgentServer, { port: 3457 });
console.log('example-typed-seller listening on :3457');
