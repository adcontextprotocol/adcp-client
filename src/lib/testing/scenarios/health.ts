/**
 * Health Check Testing Scenario
 *
 * Verifies the agent is responding and has an agent card.
 */

import type { TestOptions, TestStepResult } from '../types';
import { getOrCreateClient, getOrDiscoverProfile } from '../client';

/**
 * Test: Health Check
 * Verifies the agent is responding and has an agent card
 */
export async function testHealthCheck(agentUrl: string, options: TestOptions): Promise<TestStepResult[]> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);

  const { step } = await getOrDiscoverProfile(client, options);
  steps.push(step);

  return steps;
}
