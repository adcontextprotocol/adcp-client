/**
 * Test Controller Client
 *
 * Encapsulates all interaction with the comply_test_controller tool.
 * Handles detection, scenario discovery, and typed invocations.
 */

import type { TestClient } from './client';
import { getLogger } from './client';
import type { AgentProfile, TaskResult } from './types';
import type {
  ComplyTestControllerResponse,
  ListScenariosSuccess,
  StateTransitionSuccess,
  SimulationSuccess,
  ControllerError,
} from '../types/tools.generated';

/** Scenarios the controller can support */
export type ControllerScenario =
  | 'force_creative_status'
  | 'force_account_status'
  | 'force_media_buy_status'
  | 'force_session_status'
  | 'simulate_delivery'
  | 'simulate_budget_spend';

/** What capabilities the seller's test controller exposes */
export interface ControllerCapabilities {
  detected: true;
  scenarios: ControllerScenario[];
}

/** No test controller available */
export interface NoController {
  detected: false;
}

export type ControllerDetection = ControllerCapabilities | NoController;

const TOOL_NAME = 'comply_test_controller';

/**
 * Call executeTask on the test client.
 * TestClient is AgentClient which has executeTask, but the inferred type
 * doesn't expose it directly. This helper provides the typed bridge.
 */
function callController(client: TestClient, params: Record<string, unknown>): Promise<TaskResult> {
  // AgentClient.executeTask(taskName, params) is the public API
  return (client as unknown as { executeTask(name: string, params: Record<string, unknown>): Promise<TaskResult> })
    .executeTask(TOOL_NAME, params);
}

/** Check if the agent exposes comply_test_controller */
export function hasTestController(profile: AgentProfile): boolean {
  return profile.tools.includes(TOOL_NAME);
}

/**
 * Detect the test controller and discover supported scenarios.
 * Returns ControllerCapabilities if the tool is present and list_scenarios succeeds.
 */
export async function detectController(
  client: TestClient,
  profile: AgentProfile
): Promise<ControllerDetection> {
  if (!hasTestController(profile)) {
    return { detected: false };
  }

  try {
    const result = await callController(client, { scenario: 'list_scenarios' });

    if (!result.success || !result.data) {
      getLogger().warn(
        { tool: TOOL_NAME },
        'comply_test_controller exists but list_scenarios returned no data'
      );
      return { detected: false };
    }

    const data = result.data as ListScenariosSuccess;
    if (data.success && Array.isArray(data.scenarios)) {
      return {
        detected: true,
        scenarios: data.scenarios as ControllerScenario[],
      };
    }

    return { detected: false };
  } catch (error) {
    getLogger().warn(
      { tool: TOOL_NAME, error: error instanceof Error ? error.message : String(error) },
      'comply_test_controller list_scenarios failed — treating as unavailable'
    );
    return { detected: false };
  }
}

/** Check if a specific scenario is supported */
export function supportsScenario(
  controller: ControllerDetection,
  scenario: ControllerScenario
): boolean {
  return controller.detected && controller.scenarios.includes(scenario);
}

/**
 * Call a force_* scenario on the test controller.
 * Returns the typed response or a ControllerError on transport failure.
 */
export async function forceStatus(
  client: TestClient,
  scenario: 'force_creative_status' | 'force_account_status' | 'force_media_buy_status' | 'force_session_status',
  params: Record<string, unknown>
): Promise<StateTransitionSuccess | ControllerError> {
  const result = await callController(client, { scenario, params });

  if (!result.success || !result.data) {
    return {
      success: false,
      error: 'INTERNAL_ERROR',
      error_detail: result.error || 'Controller call failed',
    } as ControllerError;
  }

  return result.data as StateTransitionSuccess | ControllerError;
}

/**
 * Call a simulate_* scenario on the test controller.
 */
export async function simulate(
  client: TestClient,
  scenario: 'simulate_delivery' | 'simulate_budget_spend',
  params: Record<string, unknown>
): Promise<SimulationSuccess | ControllerError> {
  const result = await callController(client, { scenario, params });

  if (!result.success || !result.data) {
    return {
      success: false,
      error: 'INTERNAL_ERROR',
      error_detail: result.error || 'Controller call failed',
    } as ControllerError;
  }

  return result.data as SimulationSuccess | ControllerError;
}

/** Type guard: is the response a success? */
export function isSuccess(
  response: ComplyTestControllerResponse
): response is StateTransitionSuccess | SimulationSuccess | ListScenariosSuccess {
  return response.success === true;
}

/** Type guard: is the response an error? */
export function isControllerError(
  response: ComplyTestControllerResponse
): response is ControllerError {
  return response.success === false;
}
