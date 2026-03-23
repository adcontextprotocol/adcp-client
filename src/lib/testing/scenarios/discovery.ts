/**
 * Discovery Testing Scenario
 *
 * Tests product discovery, format listing, and property listing.
 */

import type { ListCreativeFormatsResponse, Format } from '../../types/tools.generated';
import type { TestOptions, TestStepResult, AgentProfile, TaskResult } from '../types';
import { getOrCreateClient, runStep, getOrDiscoverProfile, discoverAgentCapabilities } from '../client';

/**
 * Test: Discovery
 * Tests product discovery, format listing, and property listing
 */
export async function testDiscovery(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);

  // Discover agent profile
  const { profile, step: profileStep } = await getOrDiscoverProfile(client, options);
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
      async () => client.listCreativeFormats({}) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as ListCreativeFormatsResponse;
      const formats: Format[] = data.formats || [];
      const creativeAgents = data.creative_agents || [];
      const formatCount = formats.length;
      step.details = `Found ${formatCount} format(s), ${creativeAgents.length} creative agent(s)`;
      step.response_preview = JSON.stringify(
        {
          format_ids: formats.map(f => f.format_id).slice(0, 5),
          creative_agents: creativeAgents.map(a => a.agent_url),
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

    const data = result?.data as unknown as Record<string, unknown> | undefined;
    const publisherDomains = data?.publisher_domains as string[] | undefined;
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
