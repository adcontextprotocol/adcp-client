/**
 * Discovery Testing Scenario
 *
 * Tests product discovery, format listing, and property listing.
 */

import type { TestOptions, TestStepResult, AgentProfile, TaskResult } from '../types';
import { createTestClient, runStep, discoverAgentProfile, discoverAgentCapabilities } from '../client';

/**
 * Test: Discovery
 * Tests product discovery, format listing, and property listing
 */
export async function testDiscovery(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, options.protocol || 'mcp', options);

  // Discover agent profile
  const { profile, step: profileStep } = await discoverAgentProfile(client);
  steps.push(profileStep);

  if (!profileStep.passed) {
    return { steps, profile };
  }

  // Discover capabilities
  const { capabilities, steps: capSteps } = await discoverAgentCapabilities(client, profile, options);
  steps.push(...capSteps);

  // Merge capabilities into profile
  Object.assign(profile, capabilities);

  // List creative formats (if available)
  if (profile.tools.includes('list_creative_formats')) {
    const { result, step } = await runStep<TaskResult>(
      'List creative formats',
      'list_creative_formats',
      async () => client.executeTask('list_creative_formats', {}) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as any;
      const formatCount = data.format_ids?.length || data.formats?.length || 0;
      const creativeAgents = data.creative_agents || [];
      step.details = `Found ${formatCount} format(s), ${creativeAgents.length} creative agent(s)`;
      step.response_preview = JSON.stringify(
        {
          format_ids: (data.format_ids || data.formats?.map((f: any) => f.format_id))?.slice(0, 5),
          creative_agents: creativeAgents.map((a: any) => a.agent_url || a.url),
        },
        null,
        2
      );
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'list_creative_formats returned unsuccessful result';
    }
    steps.push(step);
  }

  // List authorized properties (if available)
  if (profile.tools.includes('list_authorized_properties')) {
    const { result, step } = await runStep<TaskResult>(
      'List authorized properties',
      'list_authorized_properties',
      async () => client.executeTask('list_authorized_properties', {}) as Promise<TaskResult>
    );

    const publisherDomains = result?.data?.publisher_domains as string[] | undefined;
    if (result?.success && publisherDomains) {
      step.details = `Found ${publisherDomains.length} publisher domain(s)`;
      step.response_preview = JSON.stringify(
        {
          publisher_domains_count: publisherDomains.length,
          domains: publisherDomains.slice(0, 3),
        },
        null,
        2
      );
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'list_authorized_properties returned unsuccessful result';
    }
    steps.push(step);
  }

  return { steps, profile };
}
