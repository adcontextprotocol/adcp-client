/**
 * Sponsored Intelligence (SI) Protocol Testing Scenarios (v3)
 *
 * Tests SI agent capabilities including:
 * - Session lifecycle (initiate -> messages -> terminate)
 * - Offering availability checks
 * - Message exchange patterns
 * - Handoff flows
 */

import type { TestOptions, TestStepResult, AgentProfile, TaskResult } from '../types';
import { createTestClient, runStep, discoverAgentProfile } from '../client';
import { SPONSORED_INTELLIGENCE_TOOLS } from '../../utils/capabilities';

/**
 * Test: SI Session Lifecycle
 *
 * Flow: si_get_offering -> si_initiate_session -> si_send_message (x2-3)
 *       -> si_terminate_session -> verify terminated
 */
export async function testSISessionLifecycle(
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

  // Check if agent supports any SI tools
  const hasSITools = SPONSORED_INTELLIGENCE_TOOLS.some(t => profile.tools.includes(t));
  if (!hasSITools) {
    steps.push({
      step: 'SI support check',
      passed: false,
      duration_ms: 0,
      error: 'Agent does not support Sponsored Intelligence tools',
      details: `Required tools: ${SPONSORED_INTELLIGENCE_TOOLS.join(', ')}. Available: ${profile.tools.join(', ')}`,
    });
    return { steps, profile };
  }

  profile.supports_si = true;
  let sessionId: string | undefined;
  let offeringToken: string | undefined;
  let offeringAvailable = false;

  // Test: si_get_offering
  if (profile.tools.includes('si_get_offering')) {
    const offeringId = options.si_offering_id || 'e2e-test-offering';
    const { result, step } = await runStep<TaskResult>(
      'Get SI offering',
      'si_get_offering',
      async () =>
        client.executeTask('si_get_offering', {
          offering_id: offeringId,
          context: options.si_context || 'E2E testing - checking SI offering availability',
          identity: {
            principal: options.auth?.token || 'e2e-test-principal',
            device_id: 'e2e-test-device',
          },
        }) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as any;
      offeringAvailable = data.available === true;
      offeringToken = data.offering_token;
      step.details = offeringAvailable
        ? `Offering available${offeringToken ? ' (token received)' : ''}`
        : `Offering unavailable: ${data.unavailable_reason || 'no reason provided'}`;
      step.response_preview = JSON.stringify(
        {
          available: data.available,
          offering_token: offeringToken ? '***' : undefined,
          title: data.title,
          description: data.description,
          capabilities: data.capabilities,
          unavailable_reason: data.unavailable_reason,
        },
        null,
        2
      );
    } else if (result && !result.success) {
      const error = result.error || '';
      if (error.includes('not supported') || error.includes('not implemented')) {
        step.passed = true;
        step.details = 'SI not supported by this agent (expected for some agents)';
      } else {
        step.passed = false;
        step.error = result.error || 'si_get_offering failed';
      }
    }
    steps.push(step);
  }

  // Test: si_initiate_session
  if (profile.tools.includes('si_initiate_session')) {
    const { result, step } = await runStep<TaskResult>(
      'Initiate SI session',
      'si_initiate_session',
      async () =>
        client.executeTask('si_initiate_session', {
          offering_id: options.si_offering_id || 'e2e-test-offering',
          offering_token: offeringToken,
          identity: {
            principal: options.auth?.token || 'e2e-test-principal',
            device_id: 'e2e-test-device',
          },
          context: options.si_context || 'E2E testing - initiating conversation about products',
          placement: 'e2e-test-placement',
          supported_capabilities: {
            modalities: {
              conversational: true,
              rich_media: true,
            },
          },
        }) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as any;
      sessionId = data.session_id;
      step.created_id = sessionId;
      step.details = sessionId
        ? `Session created: ${sessionId}`
        : 'Session initiation completed (no session_id returned)';
      step.response_preview = JSON.stringify(
        {
          session_id: sessionId,
          response_message: data.response?.message?.substring(0, 100),
          has_ui_elements: !!data.response?.ui_elements?.length,
          negotiated_capabilities: data.negotiated_capabilities,
        },
        null,
        2
      );
    } else if (result && !result.success) {
      const error = result.error || '';
      if (error.includes('not supported') || error.includes('not implemented')) {
        step.passed = true;
        step.details = 'SI session initiation not supported by this agent';
      } else {
        step.passed = false;
        step.error = result.error || 'si_initiate_session failed';
      }
    }
    steps.push(step);
  }

  // Test: si_send_message (if we have a session)
  if (profile.tools.includes('si_send_message') && sessionId) {
    const testMessages = [
      'What products do you have available?',
      'Can you tell me more about your best seller?',
      'What is the price range?',
    ];

    for (let i = 0; i < Math.min(testMessages.length, 3); i++) {
      const message = testMessages[i];
      const { result, step } = await runStep<TaskResult>(
        `Send message ${i + 1}: "${message.substring(0, 30)}..."`,
        'si_send_message',
        async () =>
          client.executeTask('si_send_message', {
            session_id: sessionId,
            message,
            metadata: {
              test_iteration: i + 1,
            },
          }) as Promise<TaskResult>
      );

      if (result?.success && result?.data) {
        const data = result.data as any;
        step.details = `Session status: ${data.session_status || 'active'}`;
        step.response_preview = JSON.stringify(
          {
            session_id: data.session_id,
            session_status: data.session_status,
            response_message: data.response?.message?.substring(0, 100),
            has_ui_elements: !!data.response?.ui_elements?.length,
          },
          null,
          2
        );

        // If session is no longer active, stop sending messages
        if (data.session_status === 'complete' || data.session_status === 'terminated') {
          steps.push(step);
          break;
        }
      } else if (result && !result.success) {
        step.passed = false;
        step.error = result.error || 'si_send_message failed';
      }
      steps.push(step);
    }
  }

  // Test: si_terminate_session (if we have a session)
  if (profile.tools.includes('si_terminate_session') && sessionId) {
    const { result, step } = await runStep<TaskResult>(
      'Terminate SI session',
      'si_terminate_session',
      async () =>
        client.executeTask('si_terminate_session', {
          session_id: sessionId,
          reason: 'user_ended',
          termination_context: {
            summary: 'E2E test session completed successfully',
          },
        }) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as any;
      step.details = data.terminated ? 'Session terminated' : 'Termination not confirmed';
      step.response_preview = JSON.stringify(
        {
          session_id: data.session_id,
          terminated: data.terminated,
          has_acp_handoff: !!data.acp_handoff,
        },
        null,
        2
      );
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'si_terminate_session failed';
    }
    steps.push(step);

    // Test: send message to terminated session (should fail)
    if (profile.tools.includes('si_send_message')) {
      const { result: errorResult, step: errorStep } = await runStep<TaskResult>(
        'Send message to terminated session (error expected)',
        'si_send_message',
        async () =>
          client.executeTask('si_send_message', {
            session_id: sessionId,
            message: 'This should fail',
          }) as Promise<TaskResult>
      );

      if (errorResult?.success) {
        // Check if session_status indicates terminated
        const data = errorResult.data as any;
        if (data.session_status === 'complete' || data.session_status === 'terminated') {
          errorStep.passed = true;
          errorStep.details = 'Session correctly reports terminated status';
        } else {
          errorStep.passed = false;
          errorStep.error = 'Expected error for terminated session but message was accepted';
        }
      } else {
        errorStep.passed = true;
        errorStep.details = 'Correctly rejected message to terminated session';
      }
      steps.push(errorStep);
    }
  }

  return { steps, profile };
}

/**
 * Test: SI Availability Check
 *
 * Quick test to check SI offering availability without full session lifecycle
 */
export async function testSIAvailability(
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

  // Check if agent supports si_get_offering
  if (!profile.tools.includes('si_get_offering')) {
    steps.push({
      step: 'SI availability check support',
      passed: false,
      duration_ms: 0,
      error: 'Agent does not support si_get_offering tool',
    });
    return { steps, profile };
  }

  profile.supports_si = true;

  // Test: si_get_offering with provided or default offering ID
  const offeringId = options.si_offering_id || 'e2e-test-offering';
  const { result, step } = await runStep<TaskResult>(
    'Check SI offering availability',
    'si_get_offering',
    async () =>
      client.executeTask('si_get_offering', {
        offering_id: offeringId,
        context: options.si_context || 'E2E testing - checking SI availability',
        identity: {
          principal: options.auth?.token || 'e2e-test-principal',
          device_id: 'e2e-test-device',
        },
      }) as Promise<TaskResult>
  );

  if (result?.success && result?.data) {
    const data = result.data as any;
    step.details = data.available
      ? 'SI offering is available'
      : `SI offering unavailable: ${data.unavailable_reason || 'no reason'}`;
    step.response_preview = JSON.stringify(
      {
        available: data.available,
        title: data.title,
        description: data.description,
        capabilities: data.capabilities,
        unavailable_reason: data.unavailable_reason,
      },
      null,
      2
    );
  } else if (result && !result.success) {
    const error = result.error || '';
    if (error.includes('not supported') || error.includes('not implemented')) {
      step.passed = true;
      step.details = 'SI not supported by this agent';
    } else {
      step.passed = false;
      step.error = result.error || 'si_get_offering failed';
    }
  }
  steps.push(step);

  // Test: si_get_offering with invalid offering ID (should return unavailable, not error)
  const { result: invalidResult, step: invalidStep } = await runStep<TaskResult>(
    'Check invalid offering availability',
    'si_get_offering',
    async () =>
      client.executeTask('si_get_offering', {
        offering_id: 'INVALID_OFFERING_ID_DOES_NOT_EXIST_12345',
        context: 'E2E testing - checking unavailable offering',
        identity: {
          principal: 'e2e-test-principal',
        },
      }) as Promise<TaskResult>
  );

  if (invalidResult?.success && invalidResult?.data) {
    const data = invalidResult.data as any;
    if (data.available === false) {
      invalidStep.passed = true;
      invalidStep.details = 'Correctly reports invalid offering as unavailable';
    } else {
      invalidStep.passed = false;
      invalidStep.error = 'Expected unavailable for invalid offering but got available';
    }
    invalidStep.response_preview = JSON.stringify(
      {
        available: data.available,
        unavailable_reason: data.unavailable_reason,
      },
      null,
      2
    );
  } else if (invalidResult && !invalidResult.success) {
    // Also acceptable to return an error for invalid offering
    invalidStep.passed = true;
    invalidStep.details = 'Correctly rejected invalid offering ID';
  }
  steps.push(invalidStep);

  return { steps, profile };
}

/**
 * Check if agent has any SI protocol tools
 */
export function hasSITools(tools: string[]): boolean {
  return SPONSORED_INTELLIGENCE_TOOLS.some(t => tools.includes(t));
}
