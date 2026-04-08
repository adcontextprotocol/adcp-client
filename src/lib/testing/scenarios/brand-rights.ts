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
 * Flow: discover profile -> check brand rights tools -> get_rights -> acquire_rights
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
 * Test: Brand Identity
 *
 * Tests get_brand_identity at public and authorized access tiers.
 */
export async function testBrandIdentity(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);

  const { profile, step: profileStep } = await getOrDiscoverProfile(client, options);
  steps.push(profileStep);

  if (!profileStep.passed) {
    return { steps, profile };
  }

  if (!profile.tools.includes('get_brand_identity')) {
    steps.push({
      step: 'Brand identity support check',
      passed: false,
      duration_ms: 0,
      error: 'Agent does not support get_brand_identity',
    });
    return { steps, profile };
  }

  // Public access tier
  const { result: publicResult, step: publicStep } = await runStep<TaskResult>(
    'Get brand identity (public access)',
    'get_brand_identity',
    async () =>
      client.executeTask('get_brand_identity', {
        type: 'get_brand_identity_request',
        request_id: `e2e-brand-pub-${Date.now()}`,
        brand_domain: options.brand?.domain ?? 'example.com',
      }) as Promise<TaskResult>
  );

  if (publicResult?.success && publicResult?.data) {
    const data = publicResult.data as Record<string, unknown>;
    publicStep.details = `Public identity returned for ${data['brand_name'] ?? data['brand_domain'] ?? 'unknown'}`;
    publicStep.response_preview = JSON.stringify(
      {
        request_id: data['request_id'],
        brand_name: data['brand_name'],
        brand_domain: data['brand_domain'],
        has_logos: Array.isArray(data['logos']) && (data['logos'] as unknown[]).length > 0,
        has_colors: !!data['colors'],
        has_tone: !!data['tone'],
      },
      null,
      2
    );
  } else if (publicResult && !publicResult.success) {
    publicStep.passed = false;
    publicStep.error = publicResult.error || 'get_brand_identity (public) failed';
  }
  steps.push(publicStep);

  // Authorized access tier (with brand_id if available)
  if (options.brand?.brand_id) {
    const { result: authResult, step: authStep } = await runStep<TaskResult>(
      'Get brand identity (authorized access)',
      'get_brand_identity',
      async () =>
        client.executeTask('get_brand_identity', {
          type: 'get_brand_identity_request',
          request_id: `e2e-brand-auth-${Date.now()}`,
          brand_domain: options.brand?.domain ?? 'example.com',
          brand_id: options.brand?.brand_id,
        }) as Promise<TaskResult>
    );

    if (authResult?.success && authResult?.data) {
      const data = authResult.data as Record<string, unknown>;
      authStep.details = `Authorized identity returned for ${data['brand_name'] ?? 'unknown'}`;
      authStep.response_preview = JSON.stringify(
        {
          request_id: data['request_id'],
          brand_name: data['brand_name'],
          access_tier: data['access_tier'],
          has_guidelines: !!data['guidelines'],
        },
        null,
        2
      );
    } else if (authResult && !authResult.success) {
      authStep.passed = false;
      authStep.error = authResult.error || 'get_brand_identity (authorized) failed';
    }
    steps.push(authStep);
  }

  return { steps, profile };
}

/**
 * Test: Creative Approval
 *
 * Tests the creative_approval workflow for brand compliance review.
 */
export async function testCreativeApproval(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);

  const { profile, step: profileStep } = await getOrDiscoverProfile(client, options);
  steps.push(profileStep);

  if (!profileStep.passed) {
    return { steps, profile };
  }

  if (!profile.tools.includes('creative_approval')) {
    steps.push({
      step: 'Creative approval support check',
      passed: false,
      duration_ms: 0,
      error: 'Agent does not support creative_approval',
    });
    return { steps, profile };
  }

  // Submit a creative for brand approval
  const { result, step } = await runStep<TaskResult>(
    'Submit creative for brand approval',
    'creative_approval',
    async () =>
      client.executeTask('creative_approval', {
        type: 'creative_approval_request',
        request_id: `e2e-approval-${Date.now()}`,
        brand_domain: options.brand?.domain ?? 'example.com',
        brand_id: options.brand?.brand_id,
        creative: {
          creative_id: `e2e-creative-${Date.now()}`,
          format: 'display_300x250',
          assets: [
            {
              asset_type: 'image',
              url: 'https://example.com/test-creative-300x250.png',
            },
          ],
        },
        dry_run: options.dry_run !== false,
      }) as Promise<TaskResult>
  );

  if (result?.success && result?.data) {
    const data = result.data as Record<string, unknown>;
    step.details = `Creative approval decision: ${data['decision'] ?? 'unknown'}`;
    step.response_preview = JSON.stringify(
      {
        request_id: data['request_id'],
        decision: data['decision'],
        feedback: data['feedback'],
        has_issues: Array.isArray(data['issues']) && (data['issues'] as unknown[]).length > 0,
      },
      null,
      2
    );
  } else if (result && !result.success) {
    const error = result.error || '';
    if (error.includes('not supported') || error.includes('not implemented')) {
      step.passed = true;
      step.details = 'creative_approval not supported by this agent (expected for some agents)';
    } else {
      step.passed = false;
      step.error = result.error || 'creative_approval failed';
    }
  }
  steps.push(step);

  return { steps, profile };
}

/**
 * Check if agent has any brand rights tools
 */
export function hasBrandRightsTools(tools: string[]): boolean {
  return BRAND_RIGHTS_TOOLS.some(t => tools.includes(t));
}
