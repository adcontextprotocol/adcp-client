/**
 * Test Controller Client — comply_test_controller integration
 *
 * Encapsulates all interaction with the comply_test_controller tool.
 * Handles detection, scenario discovery, and typed invocations.
 */

import type { TestClient } from './client';
import { getLogger, resolveAccount } from './client';
import type { AgentProfile, TaskResult, TestOptions } from './types';
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
  | 'simulate_budget_spend'
  /**
   * Returns outbound HTTP calls the agent has made since session start
   * (or since a caller-supplied timestamp). Backs the `upstream_traffic`
   * storyboard validation — adopters who advertise this scenario opt into
   * the upstream-traffic conformance contract. Spec:
   * runner-output-contract.yaml v2.0.0, comply-test-controller-request.json.
   */
  | 'query_upstream_traffic';

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

/** Fallback sandbox account when no options are available (detection phase) */
const DEFAULT_SANDBOX_ACCOUNT = { brand: { domain: 'test.example' }, operator: 'test.example', sandbox: true };

/**
 * Build the account ref for controller calls.
 * Uses the same resolution as test scenarios so entities are in the same session.
 */
function buildAccount(options?: TestOptions): Record<string, unknown> {
  if (options) {
    const account = resolveAccount(options);
    // Ensure sandbox is set — controller requires it
    return { ...account, sandbox: true };
  }
  return DEFAULT_SANDBOX_ACCOUNT;
}

/**
 * Call executeTask on the test client and parse the MCP content envelope.
 * executeTask returns { success, data: { content: [{ type: 'text', text: '...' }] } }
 * where the text is the JSON-serialized tool response. This helper extracts and parses it.
 */
async function callController(
  client: TestClient,
  params: Record<string, unknown>,
  options?: TestOptions
): Promise<TaskResult> {
  const withAccount = { account: buildAccount(options), ...params };
  const raw = await (
    client as unknown as { executeTask(name: string, params: Record<string, unknown>): Promise<TaskResult> }
  ).executeTask(TOOL_NAME, withAccount);

  // Parse the MCP content envelope to extract the JSON response.
  // Success responses come as { content: [{ type: 'text', text: '...' }] }.
  // Error responses are already parsed by the client (data has the fields directly).
  if (raw.data) {
    const data = raw.data as Record<string, unknown>;
    const content = data.content as Array<{ type: string; text?: string }> | undefined;
    if (content?.[0]?.text) {
      try {
        return { success: true, data: JSON.parse(content[0].text) };
      } catch {
        // Fall through to return raw
      }
    }
    // Error responses: data is already the parsed controller response
    if (data.error && data.success === false) {
      return { success: true, data };
    }
  }

  return raw;
}

/** Public wrapper for scenarios that need raw controller access (e.g., controller validation) */
export async function callControllerRaw(
  client: TestClient,
  params: Record<string, unknown>,
  options?: TestOptions
): Promise<TaskResult> {
  return callController(client, params, options);
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
  profile: AgentProfile,
  options?: TestOptions
): Promise<ControllerDetection> {
  if (!hasTestController(profile)) {
    return { detected: false };
  }

  try {
    const result = await callController(client, { scenario: 'list_scenarios' }, options);

    if (!result.success || !result.data) {
      getLogger().warn({ tool: TOOL_NAME }, 'comply_test_controller exists but list_scenarios returned no data');
      return { detected: false };
    }

    const data = result.data as Record<string, unknown>;
    if (data.success && data.scenarios) {
      // Handle both array format (spec) and object format (training agent returns scenario descriptions)
      const scenarios = Array.isArray(data.scenarios)
        ? (data.scenarios as ControllerScenario[])
        : (Object.keys(data.scenarios) as ControllerScenario[]);
      return {
        detected: true,
        scenarios,
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
export function supportsScenario(controller: ControllerDetection, scenario: ControllerScenario): boolean {
  return controller.detected && controller.scenarios.includes(scenario);
}

/**
 * Call a force_* scenario on the test controller.
 * Returns the typed response or a ControllerError on transport failure.
 */
export async function forceStatus(
  client: TestClient,
  scenario: 'force_creative_status' | 'force_account_status' | 'force_media_buy_status' | 'force_session_status',
  params: Record<string, unknown>,
  options?: TestOptions
): Promise<StateTransitionSuccess | ControllerError> {
  const result = await callController(client, { scenario, params }, options);

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
  params: Record<string, unknown>,
  options?: TestOptions
): Promise<SimulationSuccess | ControllerError> {
  const result = await callController(client, { scenario, params }, options);

  if (!result.success || !result.data) {
    return {
      success: false,
      error: 'INTERNAL_ERROR',
      error_detail: result.error || 'Controller call failed',
    } as ControllerError;
  }

  return result.data as SimulationSuccess | ControllerError;
}

/**
 * Single recorded outbound HTTP call returned by `query_upstream_traffic`.
 * Mirrors `comply-test-controller-response.json > UpstreamTrafficSuccess`.
 */
export interface RecordedCall {
  method: string;
  endpoint: string;
  url: string;
  host?: string;
  path?: string;
  /**
   * Media type of the recorded `payload`, mirroring the agent's outbound
   * `Content-Type` header. Required by the spec so the runner picks the
   * right matcher deterministically: `payload_must_contain` JSONPath is
   * valid only when this is `application/json` or `*+json`. Non-JSON
   * payloads fall back to substring matching for `match: present` and
   * grade `not_applicable` for `match: equals` / `match: contains_any`.
   */
  content_type: string;
  /** Decoded JSON object when content_type is JSON-shaped; raw string otherwise. */
  payload: unknown;
  timestamp: string;
  status_code?: number;
  [key: string]: unknown;
}

/**
 * Per spec PR adcontextprotocol/adcp#3816: `payload_must_contain` JSONPath
 * is valid only when `content_type` is `application/json` or has a `+json`
 * suffix.
 */
export function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return base === 'application/json' || /\+json$/.test(base);
}

export interface UpstreamTrafficSuccess {
  success: true;
  recorded_calls: RecordedCall[];
  total_count: number;
  truncated?: boolean;
  since_timestamp?: string;
}

export interface UpstreamTrafficQueryParams {
  since_timestamp?: string;
  endpoint_pattern?: string;
  limit?: number;
}

/**
 * Call the controller's `query_upstream_traffic` scenario. Returns the
 * typed success branch on success, or a `ControllerError` on transport /
 * controller-side failure. The runner uses this to back the
 * `upstream_traffic` storyboard validation.
 */
export async function queryUpstreamTraffic(
  client: TestClient,
  params: UpstreamTrafficQueryParams,
  options?: TestOptions
): Promise<UpstreamTrafficSuccess | ControllerError> {
  const result = await callController(client, { scenario: 'query_upstream_traffic', params }, options);
  if (!result.success || !result.data) {
    return {
      success: false,
      error: 'INTERNAL_ERROR',
      error_detail: result.error || 'query_upstream_traffic call failed',
    } as ControllerError;
  }
  return result.data as UpstreamTrafficSuccess | ControllerError;
}

/** Type guard: is the response a success? */
export function isSuccess(
  response: ComplyTestControllerResponse
): response is StateTransitionSuccess | SimulationSuccess | ListScenariosSuccess {
  return response.success === true;
}

/** Type guard: is the response an error? */
export function isControllerError(response: ComplyTestControllerResponse): response is ControllerError {
  return response.success === false;
}
