/**
 * Server-side comply_test_controller implementation.
 *
 * Sellers call registerTestController(server, store) to add the
 * comply_test_controller tool to their MCP server. The TestControllerStore
 * interface lets sellers wire up their own state management while the SDK
 * handles request parsing, scenario dispatch, and response formatting.
 *
 * @example
 * ```typescript
 * import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
 * import { registerTestController } from '@adcp/client/server';
 *
 * const store: TestControllerStore = {
 *   async forceAccountStatus(accountId, status) {
 *     const prev = await db.getAccountStatus(accountId);
 *     await db.setAccountStatus(accountId, status);
 *     return { success: true, previous_state: prev, current_state: status };
 *   },
 *   // ... implement other scenarios as needed
 * };
 *
 * registerTestController(server, store);
 * ```
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  ListScenariosSuccess,
  StateTransitionSuccess,
  SimulationSuccess,
  ControllerError,
  ComplyTestControllerResponse,
} from '../types/tools.generated';
import type { AccountStatus, MediaBuyStatus, CreativeStatus } from '../types/core.generated';
import {
  AccountStatusSchema,
  MediaBuyStatusSchema,
  CreativeStatusSchema,
} from '../types/schemas.generated';
import type { McpToolResponse } from './responses';
import { toStructuredContent } from './responses';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

/** Scenario names the controller can support (derived from generated schema). */
export type ControllerScenario = ListScenariosSuccess['scenarios'][number];

/**
 * Seller-side store for comply_test_controller.
 *
 * Implement the methods for each scenario you support.
 * Unimplemented methods mean that scenario is not advertised in list_scenarios.
 */
export interface TestControllerStore {
  /** Transition a creative to the specified status. */
  forceCreativeStatus?(
    creativeId: string,
    status: CreativeStatus,
    rejectionReason?: string
  ): Promise<StateTransitionSuccess>;

  /** Transition an account to the specified status. */
  forceAccountStatus?(accountId: string, status: AccountStatus): Promise<StateTransitionSuccess>;

  /** Transition a media buy to the specified status. */
  forceMediaBuyStatus?(
    mediaBuyId: string,
    status: MediaBuyStatus,
    rejectionReason?: string
  ): Promise<StateTransitionSuccess>;

  /** Transition an SI session to a terminal status. */
  forceSessionStatus?(
    sessionId: string,
    status: 'complete' | 'terminated',
    terminationReason?: string
  ): Promise<StateTransitionSuccess>;

  /** Inject synthetic delivery data for a media buy. */
  simulateDelivery?(
    mediaBuyId: string,
    params: {
      impressions?: number;
      clicks?: number;
      reported_spend?: { amount: number; currency: string };
      conversions?: number;
    }
  ): Promise<SimulationSuccess>;

  /** Simulate budget consumption to a specified percentage. */
  simulateBudgetSpend?(params: {
    account_id?: string;
    media_buy_id?: string;
    spend_percentage: number;
  }): Promise<SimulationSuccess>;
}

// ────────────────────────────────────────────────────────────
// Error class for sellers
// ────────────────────────────────────────────────────────────

/**
 * Throw from TestControllerStore methods to return a typed controller error.
 *
 * @example
 * ```typescript
 * throw new TestControllerError('NOT_FOUND', `Account ${id} not found`);
 * throw new TestControllerError('INVALID_TRANSITION', 'Cannot pause a completed buy', 'completed');
 * ```
 */
export class TestControllerError extends Error {
  constructor(
    public readonly code: ControllerError['error'],
    message: string,
    public readonly currentState?: string | null
  ) {
    super(message);
    this.name = 'TestControllerError';
  }
}

// ────────────────────────────────────────────────────────────
// Request handler (exported for testing)
// ────────────────────────────────────────────────────────────

/** Map store method presence to scenario names. */
const SCENARIO_MAP: Array<[keyof TestControllerStore, ControllerScenario]> = [
  ['forceCreativeStatus', 'force_creative_status'],
  ['forceAccountStatus', 'force_account_status'],
  ['forceMediaBuyStatus', 'force_media_buy_status'],
  ['forceSessionStatus', 'force_session_status'],
  ['simulateDelivery', 'simulate_delivery'],
  ['simulateBudgetSpend', 'simulate_budget_spend'],
];

function listScenarios(store: TestControllerStore): ControllerScenario[] {
  return SCENARIO_MAP.filter(([method]) => typeof store[method] === 'function').map(([, scenario]) => scenario);
}

function controllerError(
  code: ControllerError['error'],
  detail: string,
  currentState?: string | null
): ControllerError {
  return {
    success: false,
    error: code,
    error_detail: detail,
    ...(currentState !== undefined && { current_state: currentState }),
  };
}

/**
 * Handle a comply_test_controller request. Exported for unit testing.
 */
export async function handleTestControllerRequest(
  store: TestControllerStore,
  input: Record<string, unknown>
): Promise<ComplyTestControllerResponse> {
  const scenario = input.scenario as string | undefined;
  if (!scenario) {
    return controllerError('INVALID_PARAMS', 'Missing required field: scenario');
  }

  // list_scenarios — no params needed
  if (scenario === 'list_scenarios') {
    return { success: true, scenarios: listScenarios(store) };
  }

  const params = input.params as Record<string, unknown> | undefined;

  try {
    switch (scenario) {
      case 'force_creative_status': {
        if (!store.forceCreativeStatus) {
          return controllerError('UNKNOWN_SCENARIO', `Scenario not supported: ${scenario}`);
        }
        if (!params?.creative_id || !params?.status) {
          return controllerError('INVALID_PARAMS', 'force_creative_status requires params.creative_id and params.status');
        }
        const creativeStatus = CreativeStatusSchema.safeParse(params.status);
        if (!creativeStatus.success) {
          return controllerError('INVALID_PARAMS', `Invalid creative status: ${params.status}`);
        }
        return await store.forceCreativeStatus(
          params.creative_id as string,
          creativeStatus.data,
          params.rejection_reason as string | undefined
        );
      }

      case 'force_account_status': {
        if (!store.forceAccountStatus) {
          return controllerError('UNKNOWN_SCENARIO', `Scenario not supported: ${scenario}`);
        }
        if (!params?.account_id || !params?.status) {
          return controllerError('INVALID_PARAMS', 'force_account_status requires params.account_id and params.status');
        }
        const accountStatus = AccountStatusSchema.safeParse(params.status);
        if (!accountStatus.success) {
          return controllerError('INVALID_PARAMS', `Invalid account status: ${params.status}`);
        }
        return await store.forceAccountStatus(params.account_id as string, accountStatus.data);
      }

      case 'force_media_buy_status': {
        if (!store.forceMediaBuyStatus) {
          return controllerError('UNKNOWN_SCENARIO', `Scenario not supported: ${scenario}`);
        }
        if (!params?.media_buy_id || !params?.status) {
          return controllerError(
            'INVALID_PARAMS',
            'force_media_buy_status requires params.media_buy_id and params.status'
          );
        }
        const mediaBuyStatus = MediaBuyStatusSchema.safeParse(params.status);
        if (!mediaBuyStatus.success) {
          return controllerError('INVALID_PARAMS', `Invalid media buy status: ${params.status}`);
        }
        return await store.forceMediaBuyStatus(
          params.media_buy_id as string,
          mediaBuyStatus.data,
          params.rejection_reason as string | undefined
        );
      }

      case 'force_session_status': {
        if (!store.forceSessionStatus) {
          return controllerError('UNKNOWN_SCENARIO', `Scenario not supported: ${scenario}`);
        }
        if (!params?.session_id || !params?.status) {
          return controllerError(
            'INVALID_PARAMS',
            'force_session_status requires params.session_id and params.status'
          );
        }
        return await store.forceSessionStatus(
          params.session_id as string,
          params.status as 'complete' | 'terminated',
          params.termination_reason as string | undefined
        );
      }

      case 'simulate_delivery': {
        if (!store.simulateDelivery) {
          return controllerError('UNKNOWN_SCENARIO', `Scenario not supported: ${scenario}`);
        }
        if (!params?.media_buy_id) {
          return controllerError('INVALID_PARAMS', 'simulate_delivery requires params.media_buy_id');
        }
        return await store.simulateDelivery(params.media_buy_id as string, {
          impressions: params.impressions as number | undefined,
          clicks: params.clicks as number | undefined,
          reported_spend: params.reported_spend as { amount: number; currency: string } | undefined,
          conversions: params.conversions as number | undefined,
        });
      }

      case 'simulate_budget_spend': {
        if (!store.simulateBudgetSpend) {
          return controllerError('UNKNOWN_SCENARIO', `Scenario not supported: ${scenario}`);
        }
        if (params?.spend_percentage === undefined || params?.spend_percentage === null) {
          return controllerError('INVALID_PARAMS', 'simulate_budget_spend requires params.spend_percentage');
        }
        if (!params?.account_id && !params?.media_buy_id) {
          return controllerError(
            'INVALID_PARAMS',
            'simulate_budget_spend requires params.account_id or params.media_buy_id'
          );
        }
        return await store.simulateBudgetSpend({
          account_id: params.account_id as string | undefined,
          media_buy_id: params.media_buy_id as string | undefined,
          spend_percentage: params.spend_percentage as number,
        });
      }

      default:
        return controllerError('UNKNOWN_SCENARIO', `Unknown scenario: ${scenario}`);
    }
  } catch (err) {
    if (err instanceof TestControllerError) {
      return controllerError(err.code, err.message, err.currentState);
    }
    throw err;
  }
}

// ────────────────────────────────────────────────────────────
// MCP tool registration
// ────────────────────────────────────────────────────────────

function summarize(data: ComplyTestControllerResponse): string {
  if (data.success === false) return `Controller error: ${data.error}`;
  if ('scenarios' in data) return `Supported scenarios: ${data.scenarios.join(', ')}`;
  if ('previous_state' in data) return `Transitioned from ${data.previous_state} to ${data.current_state}`;
  return `Simulation complete: ${JSON.stringify(data.simulated)}`;
}

function toMcpResponse(data: ComplyTestControllerResponse): McpToolResponse & { isError?: true } {
  const isError = data.success === false;
  return {
    content: [{ type: 'text', text: summarize(data) }],
    structuredContent: toStructuredContent(data),
    ...(isError && { isError: true }),
  };
}

const TOOL_INPUT_SHAPE = {
  scenario: z.string().describe('Scenario to execute (e.g., list_scenarios, force_account_status)'),
  params: z.record(z.string(), z.unknown()).optional().describe('Scenario-specific parameters'),
  account: z.record(z.string(), z.unknown()).optional().describe('Account context for sandbox scoping'),
  context: z.record(z.string(), z.unknown()).optional().describe('AdCP context object'),
  ext: z.record(z.string(), z.unknown()).optional().describe('AdCP extension object'),
};

/**
 * Register the comply_test_controller tool on an MCP server.
 *
 * The store determines which scenarios are supported. Unimplemented
 * store methods are excluded from list_scenarios and return UNKNOWN_SCENARIO.
 */
export function registerTestController(server: McpServer, store: TestControllerStore): void {
  server.tool(
    'comply_test_controller',
    'Triggers seller-side state transitions for compliance testing. Sandbox only.',
    TOOL_INPUT_SHAPE,
    async (input) => {
      const response = await handleTestControllerRequest(store, input as Record<string, unknown>);
      return toMcpResponse(response);
    }
  );
}
