/**
 * Example: Seller with `comply_test_controller` wired via `createComplyController`.
 *
 * A minimal non-guaranteed seller that implements enough of the controller
 * surface to drive the `media_buy_seller` compliance storyboard: seed fixtures
 * so storyboards can reference stable product / creative IDs, and force a
 * creative to a target status so the approval flow can be exercised.
 *
 * Run with:
 *
 *   npx tsx examples/comply-controller-seller.ts
 *
 * Then drive the controller from another terminal:
 *
 *   # List advertised scenarios (force_/simulate_ only — seeds are universal)
 *   npx @adcp/client call http://localhost:3456/mcp comply_test_controller \
 *     --scenario list_scenarios
 *
 *   # Seed a product so storyboards can reference `test-product` by id
 *   npx @adcp/client call http://localhost:3456/mcp comply_test_controller \
 *     --scenario seed_product \
 *     --params '{"product_id":"test-product","fixture":{"delivery_type":"non_guaranteed"}}'
 *
 *   # Force a creative into `rejected` to drive the rejection branch
 *   npx @adcp/client call http://localhost:3456/mcp comply_test_controller \
 *     --scenario force_creative_status \
 *     --params '{"creative_id":"cr-1","status":"rejected","rejection_reason":"Brand safety"}'
 */

import { createTaskCapableServer, serve, TestControllerError } from '@adcp/client';
import { createComplyController } from '@adcp/client/testing';
import type { CreativeStatus } from '@adcp/client';

// ---------------------------------------------------------------------------
// In-memory state. In a real seller this would be Postgres / Firestore /
// whatever you already have — the controller just calls your adapters.
// ---------------------------------------------------------------------------

interface ProductFixture {
  delivery_type?: string;
  channels?: string[];
  [key: string]: unknown;
}

interface CreativeRecord {
  id: string;
  status: CreativeStatus;
  rejection_reason?: string;
  [key: string]: unknown;
}

const products = new Map<string, ProductFixture>();
const creatives = new Map<string, CreativeRecord>();

// DEMO POLICY — do not copy this table into a production state machine.
// It is permissive enough to run the example storyboards; a real seller
// encodes their approval workflow here (and in production the controller
// itself is never registered). The point of this table is to show WHERE
// transition enforcement lives — the controller routes through the same
// guard as the production path.
const CREATIVE_TRANSITIONS: Record<CreativeStatus, CreativeStatus[]> = {
  processing: ['pending_review', 'approved', 'rejected'],
  pending_review: ['approved', 'rejected'],
  approved: ['rejected', 'archived'],
  rejected: ['approved', 'archived'],
  archived: [],
};

function assertCreativeTransition(from: CreativeStatus, to: CreativeStatus): void {
  const allowed = CREATIVE_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new TestControllerError('INVALID_TRANSITION', `Creative cannot move from ${from} to ${to}`, from);
  }
}

// ---------------------------------------------------------------------------
// Controller wiring
//
// `createComplyController` is cheap to build and stateless across requests
// aside from the seed idempotency cache. Building it once at module load
// lets every request reuse the same cache, which is exactly what we want
// for deterministic storyboard replay.
// ---------------------------------------------------------------------------

const controller = createComplyController({
  // SECURITY: the sandbox gate MUST NOT trust caller-supplied fields. `ext`,
  // `context`, and `params` all flow from the client — anyone can set
  // `ext.sandbox = true`. Gate on something the server controls: an env
  // variable, a tenant flag resolved from your auth layer, or a TLS SNI
  // match. Production deployments should NOT register the controller at all.
  sandboxGate: () => process.env.ADCP_SANDBOX === '1',

  seed: {
    product: ({ product_id, fixture }, ctx) => {
      // Use ctx.input.context.session_id to scope fixtures by session if needed.
      void ctx;
      products.set(product_id, fixture);
    },
    creative: ({ creative_id, fixture }) => {
      const existing = creatives.get(creative_id);
      creatives.set(creative_id, {
        id: creative_id,
        status: (fixture.status as CreativeStatus) ?? existing?.status ?? 'pending_review',
        ...fixture,
      });
    },
  },

  force: {
    creative_status: ({ creative_id, status, rejection_reason }) => {
      const record = creatives.get(creative_id);
      if (!record) {
        throw new TestControllerError('NOT_FOUND', `Creative ${creative_id} not found`);
      }
      assertCreativeTransition(record.status, status);
      const previous = record.status;
      record.status = status;
      if (rejection_reason) record.rejection_reason = rejection_reason;
      return { success: true, previous_state: previous, current_state: status };
    },
  },
});

// ---------------------------------------------------------------------------
// Serve the controller behind an AdCP MCP server.
//
// `serve()` calls the factory once per incoming connection — build a fresh
// server each time but register the same controller so its idempotency
// cache persists across connections.
// ---------------------------------------------------------------------------

function createAgentServer() {
  const server = createTaskCapableServer({ name: 'example-comply-seller', version: '0.1.0' });
  // Register all production tools here (get_products, create_media_buy, …).
  // Omitted for brevity — this example focuses on the controller surface.
  controller.register(server);
  return server;
}

serve(createAgentServer, { port: 3456 });
