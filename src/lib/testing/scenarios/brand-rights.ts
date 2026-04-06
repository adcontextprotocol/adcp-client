/**
 * Brand Rights Protocol Testing Scenarios (v3)
 *
 * Tests brand rights agent capabilities including:
 * - get_brand_identity -- retrieves brand identity information
 * - get_rights -- queries current rights associated with a brand
 * - acquire_rights -- initiates acquisition of brand rights
 */

import type { TestOptions, TestStepResult, AgentProfile, TaskResult } from '../types';
import { getOrCreateClient, runStep, getOrDiscoverProfile } from '../client';
import { BRAND_RIGHTS_TOOLS } from '../../utils/capabilities';

/**
 * Test: Brand Rights Flow
 *
 * Flow: discover profile -> check brand rights tools -> get_brand_identity -> get_rights -> acquire_rights
 */
export async function testBrandRightsFlow(
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

  // Check if agent supports any brand rights tools
  const hasBrandRights = BRAND_RIGHTS_TOOLS.some(t => profile.tools.includes(t));
  if (!hasBrandRights) {
    steps.push({
      step: 'Brand rights support check',
      passed: false,
      duration_ms: 0,
      error: 'Agent does not support Brand Rights Protocol tools',
      details: `Required tools: ${BRAND_RIGHTS_TOOLS.join(', ')}. Available: ${profile.tools.join(', ')}`,
    });
    return { steps, profile };
  }

  // Test: get_brand_identity
  if (profile.tools.includes('get_brand_identity')) {
    const { result, step } = await runStep<TaskResult>(
      'Get brand identity: retrieve brand identity information',
      'get_brand_identity',
      async () =>
        client.executeTask('get_brand_identity', {
          type: 'get_brand_identity_request',
          request_id: `e2e-brand-id-${Date.now()}`,
          brand_domain: options.brand?.domain ?? 'example.com',
          brand_id: options.brand?.brand_id,
        }) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as Record<string, unknown>;
      step.details = `Brand identity returned for ${data['brand_name'] ?? data['brand_domain'] ?? 'unknown'}`;
      step.response_preview = JSON.stringify(
        {
          request_id: data['request_id'],
          brand_name: data['brand_name'],
          brand_domain: data['brand_domain'],
          has_guidelines: !!data['guidelines'],
        },
        null,
        2
      );
    } else if (result && !result.success) {
      const error = result.error || '';
      if (error.includes('not supported') || error.includes('not implemented')) {
        step.passed = true;
        step.details = 'get_brand_identity not supported by this agent (expected for some agents)';
      } else {
        step.passed = false;
        step.error = result.error || 'get_brand_identity failed';
      }
    }
    steps.push(step);
  }

  // Test: get_rights
  if (profile.tools.includes('get_rights')) {
    const { result, step } = await runStep<TaskResult>(
      'Get rights: query current brand rights',
      'get_rights',
      async () =>
        client.executeTask('get_rights', {
          type: 'get_rights_request',
          request_id: `e2e-rights-${Date.now()}`,
          brand_domain: options.brand?.domain ?? 'example.com',
          brand_id: options.brand?.brand_id,
        }) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as Record<string, unknown>;
      const rights = Array.isArray(data['rights']) ? data['rights'] : [];
      step.details = `Get rights returned ${rights.length} right(s)`;
      step.response_preview = JSON.stringify(
        {
          request_id: data['request_id'],
          rights_count: rights.length,
          has_expiration: rights.some((r: Record<string, unknown>) => !!r['expires_at']),
        },
        null,
        2
      );
    } else if (result && !result.success) {
      const error = result.error || '';
      if (error.includes('not supported') || error.includes('not implemented')) {
        step.passed = true;
        step.details = 'get_rights not supported by this agent (expected for some agents)';
      } else {
        step.passed = false;
        step.error = result.error || 'get_rights failed';
      }
    }
    steps.push(step);
  }

  // Test: acquire_rights
  if (profile.tools.includes('acquire_rights')) {
    const { result, step } = await runStep<TaskResult>(
      'Acquire rights: initiate brand rights acquisition',
      'acquire_rights',
      async () =>
        client.executeTask('acquire_rights', {
          type: 'acquire_rights_request',
          request_id: `e2e-acquire-${Date.now()}`,
          brand_domain: options.brand?.domain ?? 'example.com',
          brand_id: options.brand?.brand_id,
          rights_type: 'usage',
          dry_run: options.dry_run !== false,
        }) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as Record<string, unknown>;
      step.details = `Acquire rights returned status: ${data['status'] ?? 'unknown'}`;
      step.response_preview = JSON.stringify(
        {
          request_id: data['request_id'],
          status: data['status'],
          rights_id: data['rights_id'],
          dry_run: data['dry_run'],
        },
        null,
        2
      );
    } else if (result && !result.success) {
      const error = result.error || '';
      if (error.includes('not supported') || error.includes('not implemented')) {
        step.passed = true;
        step.details = 'acquire_rights not supported by this agent (expected for some agents)';
      } else {
        step.passed = false;
        step.error = result.error || 'acquire_rights failed';
      }
    }
    steps.push(step);
  }

  return { steps, profile };
}

/**
 * Check if agent has any brand rights tools
 */
export function hasBrandRightsTools(tools: string[]): boolean {
  return BRAND_RIGHTS_TOOLS.some(t => tools.includes(t));
}
