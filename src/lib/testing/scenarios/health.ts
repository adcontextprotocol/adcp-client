/**
 * Health Check Testing Scenario
 *
 * Verifies the agent is responding and has an agent card.
 */

import type { TestOptions, TestStepResult } from '../types';
import { createTestClient, discoverAgentProfile } from '../client';

/**
 * Test: Health Check
 * Verifies the agent is responding and has an agent card
 */
export async function testHealthCheck(
  agentUrl: string,
  options: TestOptions
): Promise<TestStepResult[]> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, 'mcp', options);

  const { step } = await discoverAgentProfile(client);
  steps.push(step);

  return steps;
}
