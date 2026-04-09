/**
 * Deterministic Compliance Scenarios
 *
 * These scenarios use the comply_test_controller to force seller-side
 * state transitions, enabling full state machine verification.
 * Only run when the controller is detected.
 */

import { getOrCreateClient, runStep, resolveAccount } from '../client';
import { forceStatus, simulate, supportsScenario, callControllerRaw } from '../test-controller';
import type { ControllerDetection } from '../test-controller';
import type { TestOptions, TestStepResult, AgentProfile, TaskResult } from '../types';
import type { StateTransitionSuccess, ControllerError } from '../../types/tools.generated';
import { testCreateMediaBuy, testCreativeSync } from './media-buy';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getController(options: TestOptions): ControllerDetection | undefined {
  return options._controllerCapabilities;
}

/** Extract an entity ID from step results (created_id, response_preview field, or plural array) */
function extractIdFromSteps(stepsToSearch: TestStepResult[], field: string): string | undefined {
  const pluralField = field.endsWith('_id') ? field + 's' : undefined; // creative_id → creative_ids
  for (const step of stepsToSearch) {
    if (step.created_id) return step.created_id;
    if (step.response_preview) {
      try {
        const preview = JSON.parse(step.response_preview);
        if (preview[field]) return preview[field];
        if (pluralField && Array.isArray(preview[pluralField]) && preview[pluralField][0]) {
          return preview[pluralField][0];
        }
      } catch {
        /* skip */
      }
    }
  }
  return undefined;
}

/** Build a TestStepResult from a controller transition response */
function transitionStep(
  label: string,
  response: StateTransitionSuccess | ControllerError,
  expectedSuccess: boolean,
  durationMs: number
): TestStepResult {
  const passed = response.success === expectedSuccess;
  if (response.success) {
    return {
      step: label,
      task: 'comply_test_controller',
      passed,
      duration_ms: durationMs,
      details: `${response.previous_state} → ${response.current_state}`,
      response_preview: JSON.stringify(
        { previous_state: response.previous_state, current_state: response.current_state },
        null,
        2
      ),
      ...(!passed && {
        error: `Expected failure but got success: ${response.previous_state} → ${response.current_state}`,
      }),
    };
  } else {
    return {
      step: label,
      task: 'comply_test_controller',
      passed,
      duration_ms: durationMs,
      details: `Error: ${response.error} — ${response.error_detail || ''}`,
      response_preview: JSON.stringify({ error: response.error, current_state: response.current_state }, null, 2),
      ...(!passed && { error: `Expected success but got ${response.error}: ${response.error_detail || ''}` }),
    };
  }
}

/**
 * Create timed wrappers bound to specific options.
 * This ensures controller calls use the same account as test scenarios.
 */
function createTimedHelpers(client: ReturnType<typeof getOrCreateClient>, options: TestOptions) {
  return {
    async forceStatus(
      scenario: Parameters<typeof forceStatus>[1],
      params: Parameters<typeof forceStatus>[2]
    ): Promise<{ response: Awaited<ReturnType<typeof forceStatus>>; durationMs: number }> {
      const start = Date.now();
      const response = await forceStatus(client, scenario, params, options);
      return { response, durationMs: Date.now() - start };
    },
    async simulate(
      scenario: Parameters<typeof simulate>[1],
      params: Parameters<typeof simulate>[2]
    ): Promise<{ response: Awaited<ReturnType<typeof simulate>>; durationMs: number }> {
      const start = Date.now();
      const response = await simulate(client, scenario, params, options);
      return { response, durationMs: Date.now() - start };
    },
  };
}

/**
 * Call a typed method on the client via executeTask.
 * Uses the same pattern as existing scenarios but through the typed executeTask overload.
 */
function callTask(
  client: ReturnType<typeof getOrCreateClient>,
  taskName: string,
  params: Record<string, unknown>
): Promise<TaskResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentClient.executeTask exists but TestClient type doesn't expose it directly
  return (client as any).executeTask(taskName, params) as Promise<TaskResult>;
}

// ---------------------------------------------------------------------------
// Creative State Machine
// ---------------------------------------------------------------------------

export async function testCreativeStateMachine(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);
  const controller = getController(options);

  if (!controller?.detected || !supportsScenario(controller, 'force_creative_status')) {
    steps.push({
      step: 'Controller check',
      task: 'comply_test_controller',
      passed: true,
      duration_ms: 0,
      details: 'force_creative_status not supported — skipping',
    });
    return { steps };
  }

  const ctrl = createTimedHelpers(client, options);

  // Step 1: Sync a creative to get an entity to work with
  const { steps: syncSteps, profile } = await testCreativeSync(agentUrl, options);
  steps.push(...syncSteps);

  const creativeId = extractIdFromSteps(syncSteps, 'creative_id');

  if (!creativeId) {
    steps.push({
      step: 'Find creative for state machine test',
      passed: false,
      duration_ms: 0,
      error: 'No creative_id found from sync_creatives — cannot test state machine',
    });
    return { steps, profile };
  }

  // Step 2: Force to approved
  const { response: approveResult, durationMs: approveDur } = await ctrl.forceStatus('force_creative_status', {
    creative_id: creativeId,
    status: 'approved',
  });
  steps.push(transitionStep('Force creative → approved', approveResult, true, approveDur));

  // Step 3: Verify via list_creatives
  if (approveResult.success && profile?.tools.includes('list_creatives')) {
    const { result: listResult, step: listStep } = await runStep<TaskResult>(
      'Verify creative status via list_creatives',
      'list_creatives',
      async () => callTask(client, 'list_creatives', {})
    );
    if (listResult?.success && listResult?.data) {
      const creatives = ((listResult.data as Record<string, unknown>).creatives as any[]) || [];
      const found = creatives.find((c: Record<string, unknown>) => c.creative_id === creativeId);
      if (found) {
        listStep.details = `Creative ${creativeId} status: ${found.status}`;
        if (found.status !== 'approved') {
          listStep.passed = false;
          listStep.error = `Expected status 'approved', got '${found.status}'`;
        }
      }
    }
    steps.push(listStep);
  }

  // Step 4: Force to archived
  const { response: archiveResult, durationMs: archiveDur } = await ctrl.forceStatus('force_creative_status', {
    creative_id: creativeId,
    status: 'archived',
  });
  steps.push(transitionStep('Force creative → archived', archiveResult, true, archiveDur));

  // Step 5: Invalid transition — archived is terminal, can't go back to processing
  const { response: invalidResult, durationMs: invalidDur } = await ctrl.forceStatus('force_creative_status', {
    creative_id: creativeId,
    status: 'processing',
  });
  steps.push(
    transitionStep('Invalid: archived → processing (expect INVALID_TRANSITION)', invalidResult, false, invalidDur)
  );

  if (!invalidResult.success && invalidResult.error !== 'INVALID_TRANSITION') {
    steps.push({
      step: 'Validate error code for invalid transition',
      task: 'comply_test_controller',
      passed: false,
      duration_ms: 0,
      error: `Expected error code INVALID_TRANSITION, got ${invalidResult.error}`,
    });
  }

  // Step 6: Force to rejected with reason on a fresh creative.
  // Sellers may auto-approve on sync, so force to pending_review first (the only state
  // that allows rejection in most state machines), then reject.
  const { steps: resyncSteps } = await testCreativeSync(agentUrl, options);
  const freshCreativeId = extractIdFromSteps(resyncSteps, 'creative_id');

  if (freshCreativeId) {
    // Try to reach a state that allows rejection
    const { response: toPendingReview } = await ctrl.forceStatus('force_creative_status', {
      creative_id: freshCreativeId,
      status: 'pending_review',
    });
    // Whether or not pending_review was reachable, try rejecting from wherever we are.
    // Some sellers allow rejection from processing directly; others require pending_review first.
    const { response: rejectResult, durationMs: rejectDur } = await ctrl.forceStatus('force_creative_status', {
      creative_id: freshCreativeId,
      status: 'rejected',
      rejection_reason: 'Brand safety policy violation (comply test)',
    });
    steps.push(transitionStep('Force creative → rejected with reason', rejectResult, true, rejectDur));
  }

  return { steps, profile };
}

// ---------------------------------------------------------------------------
// Media Buy State Machine
// ---------------------------------------------------------------------------

export async function testMediaBuyStateMachine(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);
  const controller = getController(options);

  if (!controller?.detected || !supportsScenario(controller, 'force_media_buy_status')) {
    steps.push({
      step: 'Controller check',
      task: 'comply_test_controller',
      passed: true,
      duration_ms: 0,
      details: 'force_media_buy_status not supported — skipping',
    });
    return { steps };
  }

  const ctrl = createTimedHelpers(client, options);

  // Create a media buy
  const { steps: createSteps, profile, mediaBuyId } = await testCreateMediaBuy(agentUrl, options);
  steps.push(...createSteps);

  if (!mediaBuyId) {
    steps.push({
      step: 'Find media buy for state machine test',
      passed: false,
      duration_ms: 0,
      error: 'No media_buy_id from create_media_buy — cannot test state machine',
    });
    return { steps, profile };
  }

  // Force to active
  const { response: activateResult, durationMs: activateDur } = await ctrl.forceStatus('force_media_buy_status', {
    media_buy_id: mediaBuyId,
    status: 'active',
  });
  steps.push(transitionStep('Force media buy → active', activateResult, true, activateDur));

  // Verify via get_media_buys
  if (activateResult.success && profile?.tools.includes('get_media_buys')) {
    const { result: getResult, step: getStep } = await runStep<TaskResult>(
      'Verify media buy status via get_media_buys',
      'get_media_buys',
      async () => callTask(client, 'get_media_buys', { media_buy_id: mediaBuyId })
    );
    if (getResult?.success && getResult?.data) {
      const data = getResult.data as Record<string, unknown>;
      const buys = (data.media_buys as Record<string, unknown>[]) || [data];
      const found = buys.find((b: Record<string, unknown>) => b.media_buy_id === mediaBuyId);
      if (found) {
        getStep.details = `Media buy ${mediaBuyId} status: ${found.status}`;
        if (found.status !== 'active') {
          getStep.passed = false;
          getStep.error = `Expected status 'active', got '${found.status}'`;
        }
      }
    }
    steps.push(getStep);
  }

  // Force to completed (terminal)
  const { response: completeResult, durationMs: completeDur } = await ctrl.forceStatus('force_media_buy_status', {
    media_buy_id: mediaBuyId,
    status: 'completed',
  });
  steps.push(transitionStep('Force media buy → completed', completeResult, true, completeDur));

  // Invalid: completed → active (terminal)
  const { response: invalidResult, durationMs: invalidDur } = await ctrl.forceStatus('force_media_buy_status', {
    media_buy_id: mediaBuyId,
    status: 'active',
  });
  steps.push(
    transitionStep('Invalid: completed → active (expect INVALID_TRANSITION)', invalidResult, false, invalidDur)
  );

  // Test rejection: force to pending_start first (some sellers create as active),
  // then reject from there. If the seller doesn't support pending_start, skip.
  const { steps: create2Steps, mediaBuyId: mediaBuyId2 } = await testCreateMediaBuy(agentUrl, options);
  steps.push(...create2Steps);

  if (mediaBuyId2) {
    // Try to force to pending_start first
    const { response: pendingResult } = await ctrl.forceStatus('force_media_buy_status', {
      media_buy_id: mediaBuyId2,
      status: 'pending_start',
    });

    if (pendingResult.success) {
      // Now reject from pending_start
      const { response: rejectResult, durationMs: rejectDur } = await ctrl.forceStatus('force_media_buy_status', {
        media_buy_id: mediaBuyId2,
        status: 'rejected',
        rejection_reason: 'Policy violation (comply test)',
      });
      steps.push(transitionStep('Force media buy → rejected from pending_start', rejectResult, true, rejectDur));
    } else {
      // Can't reach pending_start — test cancellation instead (valid from active)
      const { response: cancelResult, durationMs: cancelDur } = await ctrl.forceStatus('force_media_buy_status', {
        media_buy_id: mediaBuyId2,
        status: 'canceled',
      });
      steps.push(transitionStep('Force media buy → canceled from active', cancelResult, true, cancelDur));
    }
  }

  return { steps, profile };
}

// ---------------------------------------------------------------------------
// Account State Machine
// ---------------------------------------------------------------------------

export async function testAccountStateMachine(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);
  const controller = getController(options);

  if (!controller?.detected || !supportsScenario(controller, 'force_account_status')) {
    steps.push({
      step: 'Controller check',
      task: 'comply_test_controller',
      passed: true,
      duration_ms: 0,
      details: 'force_account_status not supported — skipping',
    });
    return { steps };
  }

  const ctrl = createTimedHelpers(client, options);

  // Discover an account to work with
  const profile = options._profile;
  let accountId: string | undefined;

  if (profile?.tools.includes('list_accounts')) {
    const { result: listResult, step: listStep } = await runStep<TaskResult>(
      'List accounts for state machine test',
      'list_accounts',
      async () => callTask(client, 'list_accounts', {})
    );
    if (listResult?.success && listResult?.data) {
      const accounts = ((listResult.data as Record<string, unknown>).accounts as Record<string, unknown>[]) || [];
      const active = accounts.find((a: Record<string, unknown>) => a.status === 'active');
      accountId = (active?.account_id || accounts[0]?.account_id) as string | undefined;
      listStep.details = `Found ${accounts.length} account(s), using ${accountId || 'none'}`;
    }
    steps.push(listStep);
  }

  if (!accountId) {
    steps.push({
      step: 'Find account for state machine test',
      passed: true,
      duration_ms: 0,
      details: 'No account found — skipping account state machine test',
    });
    return { steps, profile };
  }

  // Force to suspended
  const { response: suspendResult, durationMs: suspendDur } = await ctrl.forceStatus('force_account_status', {
    account_id: accountId,
    status: 'suspended',
  });
  steps.push(transitionStep('Force account → suspended', suspendResult, true, suspendDur));

  // Verify operations are gated: create_media_buy should fail
  if (suspendResult.success && profile?.tools.includes('create_media_buy') && profile?.tools.includes('get_products')) {
    const { result: createResult, step: createStep } = await runStep<TaskResult>(
      'Verify create_media_buy blocked when suspended',
      'create_media_buy',
      async () =>
        callTask(client, 'create_media_buy', {
          brief: 'comply test — should be blocked by suspension',
          budget: { amount: 100, currency: 'USD' },
        })
    );
    // We expect this to fail
    if (createResult?.success) {
      createStep.passed = false;
      createStep.error = 'create_media_buy succeeded but account is suspended — operation gate not enforced';
    } else {
      createStep.passed = true;
      createStep.details = 'create_media_buy correctly blocked when account is suspended';
    }
    steps.push(createStep);
  }

  // Reactivate
  const { response: reactivateResult, durationMs: reactivateDur } = await ctrl.forceStatus('force_account_status', {
    account_id: accountId,
    status: 'active',
  });
  steps.push(transitionStep('Force account → active (reactivate)', reactivateResult, true, reactivateDur));

  // Force to payment_required
  const { response: paymentResult, durationMs: paymentDur } = await ctrl.forceStatus('force_account_status', {
    account_id: accountId,
    status: 'payment_required',
  });
  steps.push(transitionStep('Force account → payment_required', paymentResult, true, paymentDur));

  // Restore to active
  const { response: restoreResult, durationMs: restoreDur } = await ctrl.forceStatus('force_account_status', {
    account_id: accountId,
    status: 'active',
  });
  steps.push(transitionStep('Force account → active (restore)', restoreResult, true, restoreDur));

  return { steps, profile };
}

// ---------------------------------------------------------------------------
// SI Session State Machine
// ---------------------------------------------------------------------------

export async function testSessionStateMachine(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);
  const controller = getController(options);
  const profile = options._profile;

  if (!controller?.detected || !supportsScenario(controller, 'force_session_status')) {
    steps.push({
      step: 'Controller check',
      task: 'comply_test_controller',
      passed: true,
      duration_ms: 0,
      details: 'force_session_status not supported — skipping',
    });
    return { steps };
  }

  if (!profile?.tools.includes('si_initiate_session')) {
    steps.push({
      step: 'SI tools check',
      passed: true,
      duration_ms: 0,
      details: 'si_initiate_session not available — skipping',
    });
    return { steps };
  }

  const ctrl = createTimedHelpers(client, options);

  // Initiate a session
  const { result: initResult, step: initStep } = await runStep<TaskResult>(
    'Initiate SI session for state machine test',
    'si_initiate_session',
    async () =>
      callTask(client, 'si_initiate_session', {
        identity: { user_type: 'consumer' },
        supported_capabilities: { response_formats: ['text'] },
      })
  );
  steps.push(initStep);

  const sessionId = (initResult?.data as Record<string, unknown> | undefined)?.session_id as string | undefined;
  if (!sessionId) {
    steps.push({
      step: 'Extract session ID',
      passed: false,
      duration_ms: 0,
      error: 'No session_id in initiate response',
    });
    return { steps, profile };
  }

  // Force session timeout
  const { response: timeoutResult, durationMs: timeoutDur } = await ctrl.forceStatus('force_session_status', {
    session_id: sessionId,
    status: 'terminated',
    termination_reason: 'session_timeout',
  });
  steps.push(transitionStep('Force session → terminated (timeout)', timeoutResult, true, timeoutDur));

  // Verify: si_send_message should fail with SESSION_NOT_FOUND or similar
  if (timeoutResult.success && profile.tools.includes('si_send_message')) {
    const { result: msgResult, step: msgStep } = await runStep<TaskResult>(
      'Verify si_send_message fails after forced termination',
      'si_send_message',
      async () =>
        callTask(client, 'si_send_message', {
          session_id: sessionId,
          message: 'comply test — session should be terminated',
        })
    );

    if (msgResult?.success) {
      const data = msgResult.data as Record<string, unknown> | undefined;
      const errors = data?.errors as unknown[] | undefined;
      if ((errors && errors.length > 0) || data?.session_status === 'terminated') {
        msgStep.passed = true;
        msgStep.details = 'Agent correctly returned error/terminated status for expired session';
      } else {
        msgStep.passed = false;
        msgStep.error = 'si_send_message succeeded on terminated session — session state not enforced';
      }
    } else {
      msgStep.passed = true;
      msgStep.details = 'si_send_message correctly failed on terminated session';
    }
    steps.push(msgStep);
  }

  return { steps, profile };
}

// ---------------------------------------------------------------------------
// Delivery Simulation
// ---------------------------------------------------------------------------

export async function testDeliverySimulation(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);
  const controller = getController(options);
  const profile = options._profile;

  if (!controller?.detected || !supportsScenario(controller, 'simulate_delivery')) {
    steps.push({
      step: 'Controller check',
      task: 'comply_test_controller',
      passed: true,
      duration_ms: 0,
      details: 'simulate_delivery not supported — skipping',
    });
    return { steps };
  }

  const ctrl = createTimedHelpers(client, options);

  // Create a media buy to simulate delivery on
  const { steps: createSteps, mediaBuyId } = await testCreateMediaBuy(agentUrl, options);
  steps.push(...createSteps);

  if (!mediaBuyId) {
    steps.push({
      step: 'Find media buy for delivery simulation',
      passed: false,
      duration_ms: 0,
      error: 'No media_buy_id — cannot test delivery simulation',
    });
    return { steps, profile };
  }

  // Simulate delivery
  const { response: simResult, durationMs: simDur } = await ctrl.simulate('simulate_delivery', {
    media_buy_id: mediaBuyId,
    impressions: 10000,
    clicks: 150,
    reported_spend: { amount: 150.0, currency: 'USD' },
  });

  if (simResult.success) {
    steps.push({
      step: 'Simulate delivery data',
      task: 'comply_test_controller',
      passed: true,
      duration_ms: simDur,
      details: simResult.message || 'Delivery simulated',
      response_preview: JSON.stringify(simResult.simulated, null, 2),
    });
  } else {
    steps.push({
      step: 'Simulate delivery data',
      task: 'comply_test_controller',
      passed: false,
      duration_ms: simDur,
      error: `${simResult.error}: ${simResult.error_detail || ''}`,
    });
    return { steps, profile };
  }

  // Verify via get_media_buy_delivery
  if (profile?.tools.includes('get_media_buy_delivery')) {
    const { result: deliveryResult, step: deliveryStep } = await runStep<TaskResult>(
      'Verify delivery data via get_media_buy_delivery',
      'get_media_buy_delivery',
      async () =>
        callTask(client, 'get_media_buy_delivery', { media_buy_id: mediaBuyId, account: resolveAccount(options) })
    );

    if (deliveryResult?.success && deliveryResult?.data) {
      const data = deliveryResult.data as Record<string, unknown>;
      // Handle multiple response shapes:
      // - { media_buy_deliveries: [{ totals: { impressions } }] } (training agent)
      // - { summary: { impressions } } or { impressions } (other agents)
      const deliveries = data.media_buy_deliveries as Record<string, unknown>[] | undefined;
      const totals = deliveries?.[0]?.totals as Record<string, unknown> | undefined;
      const summary = data.summary as Record<string, unknown> | undefined;
      const impressions = (totals?.impressions ??
        data.impressions ??
        data.total_impressions ??
        summary?.impressions) as number | undefined;
      if (impressions !== undefined && impressions >= 10000) {
        deliveryStep.details = `Delivery reflects simulated data: ${impressions} impressions`;
      } else {
        deliveryStep.passed = false;
        deliveryStep.error = `Expected ≥10000 impressions in delivery report, got ${impressions}`;
      }
      deliveryStep.response_preview = JSON.stringify({ impressions, raw_keys: Object.keys(data) }, null, 2);
    }
    steps.push(deliveryStep);
  }

  return { steps, profile };
}

// ---------------------------------------------------------------------------
// Budget Simulation
// ---------------------------------------------------------------------------

export async function testBudgetSimulation(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);
  const controller = getController(options);
  const profile = options._profile;

  if (!controller?.detected || !supportsScenario(controller, 'simulate_budget_spend')) {
    steps.push({
      step: 'Controller check',
      task: 'comply_test_controller',
      passed: true,
      duration_ms: 0,
      details: 'simulate_budget_spend not supported — skipping',
    });
    return { steps };
  }

  const ctrl = createTimedHelpers(client, options);

  // Create a media buy with a known budget
  const { steps: createSteps, mediaBuyId } = await testCreateMediaBuy(agentUrl, options);
  steps.push(...createSteps);

  if (!mediaBuyId) {
    steps.push({
      step: 'Find media buy for budget simulation',
      passed: false,
      duration_ms: 0,
      error: 'No media_buy_id — cannot test budget simulation',
    });
    return { steps, profile };
  }

  // Simulate 95% spend
  const { response: simResult, durationMs: simDur } = await ctrl.simulate('simulate_budget_spend', {
    media_buy_id: mediaBuyId,
    spend_percentage: 95,
  });

  if (simResult.success) {
    steps.push({
      step: 'Simulate budget spend to 95%',
      task: 'comply_test_controller',
      passed: true,
      duration_ms: simDur,
      details: simResult.message || 'Budget spend simulated to 95%',
      response_preview: JSON.stringify(simResult.simulated, null, 2),
    });
  } else {
    steps.push({
      step: 'Simulate budget spend to 95%',
      task: 'comply_test_controller',
      passed: false,
      duration_ms: simDur,
      error: `${simResult.error}: ${simResult.error_detail || ''}`,
    });
    return { steps, profile };
  }

  // Simulate 100% spend
  const { response: depletedResult, durationMs: depletedDur } = await ctrl.simulate('simulate_budget_spend', {
    media_buy_id: mediaBuyId,
    spend_percentage: 100,
  });

  if (depletedResult.success) {
    steps.push({
      step: 'Simulate budget fully depleted (100%)',
      task: 'comply_test_controller',
      passed: true,
      duration_ms: depletedDur,
      details: depletedResult.message || 'Budget fully depleted',
      response_preview: JSON.stringify(depletedResult.simulated, null, 2),
    });
  } else {
    steps.push({
      step: 'Simulate budget fully depleted (100%)',
      task: 'comply_test_controller',
      passed: false,
      duration_ms: depletedDur,
      error: `${depletedResult.error}: ${depletedResult.error_detail || ''}`,
    });
  }

  return { steps, profile };
}

// ---------------------------------------------------------------------------
// Controller Self-Validation
// ---------------------------------------------------------------------------

export async function testControllerValidation(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);
  const controller = getController(options);

  if (!controller?.detected) {
    steps.push({
      step: 'Controller check',
      task: 'comply_test_controller',
      passed: true,
      duration_ms: 0,
      details: 'No test controller — skipping validation',
    });
    return { steps };
  }

  // Test 1: Unknown scenario → expect UNKNOWN_SCENARIO
  const { result: unknownResult, step: unknownStep } = await runStep<TaskResult>(
    'Unknown scenario returns UNKNOWN_SCENARIO',
    'comply_test_controller',
    async () =>
      callControllerRaw(
        client,
        {
          scenario: 'nonexistent_scenario',
          params: {},
        },
        options
      )
  );

  const unknownData = unknownResult?.data as ControllerError | undefined;
  if (unknownData && !unknownData.success && unknownData.error === 'UNKNOWN_SCENARIO') {
    unknownStep.details = 'Correctly returned UNKNOWN_SCENARIO for nonexistent_scenario';
  } else {
    unknownStep.passed = false;
    unknownStep.error = `Expected UNKNOWN_SCENARIO error, got: ${JSON.stringify(unknownData)}`;
  }
  steps.push(unknownStep);

  // Test 2: Missing required params → expect INVALID_PARAMS
  if (supportsScenario(controller, 'force_creative_status')) {
    const start = Date.now();
    const missingResult = await forceStatus(client, 'force_creative_status', {}, options);
    const dur = Date.now() - start;
    if (!missingResult.success && missingResult.error === 'INVALID_PARAMS') {
      steps.push({
        step: 'Missing params returns INVALID_PARAMS',
        task: 'comply_test_controller',
        passed: true,
        duration_ms: dur,
        details: 'Correctly returned INVALID_PARAMS for missing creative_id/status',
      });
    } else {
      steps.push({
        step: 'Missing params returns INVALID_PARAMS',
        task: 'comply_test_controller',
        passed: false,
        duration_ms: dur,
        error: `Expected INVALID_PARAMS, got: ${!missingResult.success ? missingResult.error : 'success'}`,
      });
    }
  }

  // Test 3: NOT_FOUND for nonexistent entity
  if (supportsScenario(controller, 'force_creative_status')) {
    const start = Date.now();
    const notFoundResult = await forceStatus(
      client,
      'force_creative_status',
      {
        creative_id: 'comply-test-nonexistent-000000000000',
        status: 'approved',
      },
      options
    );
    const dur = Date.now() - start;
    if (!notFoundResult.success && notFoundResult.error === 'NOT_FOUND') {
      steps.push({
        step: 'Nonexistent entity returns NOT_FOUND',
        task: 'comply_test_controller',
        passed: true,
        duration_ms: dur,
        details: 'Correctly returned NOT_FOUND for nonexistent creative',
      });
    } else {
      steps.push({
        step: 'Nonexistent entity returns NOT_FOUND',
        task: 'comply_test_controller',
        passed: false,
        duration_ms: dur,
        error: `Expected NOT_FOUND, got: ${!notFoundResult.success ? notFoundResult.error : 'success'}`,
      });
    }
  }

  return { steps };
}
