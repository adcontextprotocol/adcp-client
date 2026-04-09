/**
 * SDK-provided comply_test_controller for deterministic compliance testing.
 *
 * Sellers who use `registerTestController(server, store)` get the test controller
 * tool registered automatically. The controller enables deterministic state
 * transitions for compliance testing without waiting for async workflows.
 *
 * The store tracks entity states (accounts, media buys, creatives, sessions)
 * and delivery/budget simulation data. Sellers populate the store from their
 * tool handlers (e.g., when create_media_buy creates a buy, store its ID and
 * initial status). The controller then forces transitions on those entities.
 *
 * @example
 * ```typescript
 * import { createTaskCapableServer, registerTestController, TestControllerStore } from '@adcp/client';
 *
 * const store = new TestControllerStore();
 * const server = createTaskCapableServer('My Agent', '1.0.0');
 * registerTestController(server, store);
 *
 * // In your create_media_buy handler:
 * store.setMediaBuyStatus(mediaBuyId, 'pending_activation');
 * ```
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { taskToolResponse } from './tasks';

// ---------------------------------------------------------------------------
// State store
// ---------------------------------------------------------------------------

interface DeliveryData {
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
}

/**
 * In-memory state store for the test controller.
 *
 * Sellers populate this from their tool handlers so the controller
 * can force transitions on known entities.
 */
export class TestControllerStore {
  private accounts = new Map<string, string>();
  private mediaBuys = new Map<string, string>();
  private creatives = new Map<string, string>();
  private sessions = new Map<string, string>();
  private delivery = new Map<string, DeliveryData>();
  private budgets = new Map<string, { total: number; spent: number }>();

  // --- Setters (called from seller tool handlers) ---

  setAccountStatus(id: string, status: string): void {
    this.accounts.set(id, status);
  }

  setMediaBuyStatus(id: string, status: string): void {
    this.mediaBuys.set(id, status);
  }

  setCreativeStatus(id: string, status: string): void {
    this.creatives.set(id, status);
  }

  setSessionStatus(id: string, status: string): void {
    this.sessions.set(id, status);
  }

  setMediaBuyBudget(id: string, total: number): void {
    this.budgets.set(id, { total, spent: 0 });
  }

  // --- Getters ---

  getAccountStatus(id: string): string | undefined {
    return this.accounts.get(id);
  }

  getMediaBuyStatus(id: string): string | undefined {
    return this.mediaBuys.get(id);
  }

  getCreativeStatus(id: string): string | undefined {
    return this.creatives.get(id);
  }

  getSessionStatus(id: string): string | undefined {
    return this.sessions.get(id);
  }

  getDelivery(id: string): DeliveryData {
    return this.delivery.get(id) ?? { impressions: 0, clicks: 0, spend: 0, conversions: 0 };
  }

  getBudget(id: string): { total: number; spent: number } | undefined {
    return this.budgets.get(id);
  }

  // --- Force state transitions ---

  forceAccountStatus(id: string, status: string): { previous: string; current: string } | null {
    const previous = this.accounts.get(id);
    if (previous === undefined) return null;
    this.accounts.set(id, status);
    return { previous, current: status };
  }

  forceMediaBuyStatus(id: string, status: string): { previous: string; current: string } | null {
    const previous = this.mediaBuys.get(id);
    if (previous === undefined) return null;
    const terminal = ['completed', 'rejected', 'canceled'];
    if (terminal.includes(previous)) return null;
    this.mediaBuys.set(id, status);
    return { previous, current: status };
  }

  forceCreativeStatus(id: string, status: string): { previous: string; current: string } | null {
    const previous = this.creatives.get(id);
    if (previous === undefined) return null;
    if (previous === 'archived') return null;
    this.creatives.set(id, status);
    return { previous, current: status };
  }

  forceSessionStatus(id: string, status: string): { previous: string; current: string } | null {
    const previous = this.sessions.get(id);
    if (previous === undefined) return null;
    if (previous === 'terminated' || previous === 'complete') return null;
    this.sessions.set(id, status);
    return { previous, current: status };
  }

  // --- Simulation ---

  addDelivery(id: string, impressions?: number, clicks?: number, spend?: number, conversions?: number): DeliveryData {
    const current = this.delivery.get(id) ?? { impressions: 0, clicks: 0, spend: 0, conversions: 0 };
    current.impressions += impressions ?? 0;
    current.clicks += clicks ?? 0;
    current.spend += spend ?? 0;
    current.conversions += conversions ?? 0;
    this.delivery.set(id, current);
    return current;
  }

  simulateBudgetSpend(id: string, percentage: number): { total: number; spent: number } | null {
    const budget = this.budgets.get(id);
    if (!budget) return null;
    budget.spent = (budget.total * percentage) / 100;
    return { ...budget };
  }
}

// ---------------------------------------------------------------------------
// Supported scenarios
// ---------------------------------------------------------------------------

const SUPPORTED_SCENARIOS = [
  'force_creative_status',
  'force_account_status',
  'force_media_buy_status',
  'force_session_status',
  'simulate_delivery',
  'simulate_budget_spend',
] as const;

// ---------------------------------------------------------------------------
// Register the tool
// ---------------------------------------------------------------------------

/**
 * Register the comply_test_controller tool on an MCP server.
 *
 * The controller enables deterministic compliance testing by exposing
 * force_* and simulate_* scenarios. Sellers populate the store from
 * their business logic handlers.
 */
export function registerTestController(server: McpServer, store: TestControllerStore): void {
  const inputSchema = {
    scenario: z.enum([
      'list_scenarios',
      'force_account_status',
      'force_media_buy_status',
      'force_creative_status',
      'force_session_status',
      'simulate_delivery',
      'simulate_budget_spend',
    ]),
    params: z.record(z.string(), z.unknown()).optional(),
    context: z.record(z.string(), z.unknown()).optional(),
    ext: z.record(z.string(), z.unknown()).optional(),
  };

  server.tool(
    'comply_test_controller',
    'Force entity state transitions and simulate delivery/budget for deterministic compliance testing.',
    inputSchema,
    async args => {
      const scenario = args.scenario;
      const params = (args.params ?? {}) as Record<string, unknown>;

      switch (scenario) {
        case 'list_scenarios':
          return taskToolResponse({
            success: true,
            scenarios: [...SUPPORTED_SCENARIOS],
          });

        case 'force_account_status': {
          const id = typeof params.account_id === 'string' ? params.account_id : '';
          const status = typeof params.status === 'string' ? params.status : '';
          if (!id || !status) {
            return taskToolResponse({
              success: false,
              error: 'INVALID_PARAMS',
              error_detail: 'account_id and status required',
            });
          }
          const result = store.forceAccountStatus(id, status);
          if (!result) {
            const current = store.getAccountStatus(id);
            if (current === undefined) {
              return taskToolResponse({ success: false, error: 'NOT_FOUND', error_detail: `Account ${id} not found` });
            }
            return taskToolResponse({ success: false, error: 'INVALID_TRANSITION', current_state: current });
          }
          return taskToolResponse({ success: true, previous_state: result.previous, current_state: result.current });
        }

        case 'force_media_buy_status': {
          const id = typeof params.media_buy_id === 'string' ? params.media_buy_id : '';
          const status = typeof params.status === 'string' ? params.status : '';
          if (!id || !status) {
            return taskToolResponse({
              success: false,
              error: 'INVALID_PARAMS',
              error_detail: 'media_buy_id and status required',
            });
          }
          const result = store.forceMediaBuyStatus(id, status);
          if (!result) {
            const current = store.getMediaBuyStatus(id);
            if (current === undefined) {
              return taskToolResponse({
                success: false,
                error: 'NOT_FOUND',
                error_detail: `Media buy ${id} not found`,
              });
            }
            return taskToolResponse({ success: false, error: 'INVALID_TRANSITION', current_state: current });
          }
          return taskToolResponse({ success: true, previous_state: result.previous, current_state: result.current });
        }

        case 'force_creative_status': {
          const id = typeof params.creative_id === 'string' ? params.creative_id : '';
          const status = typeof params.status === 'string' ? params.status : '';
          if (!id || !status) {
            return taskToolResponse({
              success: false,
              error: 'INVALID_PARAMS',
              error_detail: 'creative_id and status required',
            });
          }
          const result = store.forceCreativeStatus(id, status);
          if (!result) {
            const current = store.getCreativeStatus(id);
            if (current === undefined) {
              return taskToolResponse({ success: false, error: 'NOT_FOUND', error_detail: `Creative ${id} not found` });
            }
            return taskToolResponse({ success: false, error: 'INVALID_TRANSITION', current_state: current });
          }
          return taskToolResponse({ success: true, previous_state: result.previous, current_state: result.current });
        }

        case 'force_session_status': {
          const id = typeof params.session_id === 'string' ? params.session_id : '';
          const status = typeof params.status === 'string' ? params.status : '';
          if (!id || !status) {
            return taskToolResponse({
              success: false,
              error: 'INVALID_PARAMS',
              error_detail: 'session_id and status required',
            });
          }
          const result = store.forceSessionStatus(id, status);
          if (!result) {
            const current = store.getSessionStatus(id);
            if (current === undefined) {
              return taskToolResponse({ success: false, error: 'NOT_FOUND', error_detail: `Session ${id} not found` });
            }
            return taskToolResponse({ success: false, error: 'INVALID_TRANSITION', current_state: current });
          }
          return taskToolResponse({ success: true, previous_state: result.previous, current_state: result.current });
        }

        case 'simulate_delivery': {
          const id = typeof params.media_buy_id === 'string' ? params.media_buy_id : '';
          if (!id) {
            return taskToolResponse({ success: false, error: 'INVALID_PARAMS', error_detail: 'media_buy_id required' });
          }
          const toNum = (v: unknown): number => (typeof v === 'number' && !isNaN(v) ? v : 0);
          const spend = params.reported_spend as Record<string, unknown> | undefined;
          const simulated = {
            impressions: toNum(params.impressions),
            clicks: toNum(params.clicks),
            spend: toNum(spend?.amount),
            conversions: toNum(params.conversions),
          };
          const cumulative = store.addDelivery(
            id,
            simulated.impressions,
            simulated.clicks,
            simulated.spend,
            simulated.conversions
          );
          return taskToolResponse({ success: true, simulated, cumulative });
        }

        case 'simulate_budget_spend': {
          const id = typeof params.media_buy_id === 'string' ? params.media_buy_id : '';
          const pct = typeof params.spend_percentage === 'number' ? params.spend_percentage : NaN;
          if (!id || isNaN(pct)) {
            return taskToolResponse({
              success: false,
              error: 'INVALID_PARAMS',
              error_detail: 'media_buy_id and spend_percentage required',
            });
          }
          const result = store.simulateBudgetSpend(id, pct);
          if (!result) {
            return taskToolResponse({
              success: false,
              error: 'NOT_FOUND',
              error_detail: `Media buy ${id} not found or no budget set`,
            });
          }
          return taskToolResponse({
            success: true,
            simulated: { spend_percentage: pct, spent: result.spent, total: result.total },
          });
        }

        default:
          return taskToolResponse({
            success: false,
            error: 'UNKNOWN_SCENARIO',
            error_detail: `Unknown scenario: ${scenario}`,
          });
      }
    }
  );
}
