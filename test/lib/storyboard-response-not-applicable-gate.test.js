/**
 * Tests for the response-derived not_applicable phase gate (adcp-client#1959).
 *
 * The gate fires before a phase's steps execute, based on context keys
 * populated by prior steps' `context_outputs` extraction. Its primary use
 * case is pagination storyboards: after the first `list_accounts` response
 * proves there is no second page (cursor absent), the cursor-walk phase is
 * graded `not_applicable` rather than run and failed.
 *
 * Integration tests use `_client` injection so no network calls are made.
 * Unit tests for `evaluateResponseNotApplicableGate` pin predicate semantics
 * directly without a full runStoryboard() roundtrip.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { runStoryboard, evaluateResponseNotApplicableGate } = require('../../dist/lib/testing/storyboard/index.js');

// ─────────────────────────────────────────────────────────────────────────────
// evaluateResponseNotApplicableGate unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('evaluateResponseNotApplicableGate unit tests (#1959)', () => {
  test('absent predicate: fires when key is undefined', () => {
    const result = evaluateResponseNotApplicableGate({ context_key: 'cursor', predicate: 'absent' }, {});
    assert.ok(result !== null, 'gate should fire');
    assert.ok(result.includes('cursor'), 'detail should reference the key');
  });

  test('absent predicate: fires when key is null', () => {
    const result = evaluateResponseNotApplicableGate({ context_key: 'cursor', predicate: 'absent' }, { cursor: null });
    assert.ok(result !== null, 'null counts as absent');
  });

  test('absent predicate: does NOT fire when key is present', () => {
    const result = evaluateResponseNotApplicableGate(
      { context_key: 'cursor', predicate: 'absent' },
      { cursor: 'abc123' }
    );
    assert.equal(result, null, 'gate should not fire when cursor is present');
  });

  test('absent predicate: does NOT fire when key is false (present but falsy)', () => {
    const result = evaluateResponseNotApplicableGate({ context_key: 'flag', predicate: 'absent' }, { flag: false });
    assert.equal(result, null, 'false is present, not absent');
  });

  test('absent predicate: does NOT fire when key is zero', () => {
    const result = evaluateResponseNotApplicableGate({ context_key: 'count', predicate: 'absent' }, { count: 0 });
    assert.equal(result, null, '0 is present, not absent');
  });

  test('present predicate: fires when key has a value', () => {
    const result = evaluateResponseNotApplicableGate(
      { context_key: 'error_code', predicate: 'present' },
      { error_code: 'NOT_FOUND' }
    );
    assert.ok(result !== null, 'gate should fire when key is present');
  });

  test('present predicate: does NOT fire when key is absent', () => {
    const result = evaluateResponseNotApplicableGate({ context_key: 'error_code', predicate: 'present' }, {});
    assert.equal(result, null, 'gate should not fire when key absent');
  });

  test('equals predicate: fires when value matches', () => {
    const result = evaluateResponseNotApplicableGate(
      { context_key: 'status', predicate: { equals: 'done' } },
      { status: 'done' }
    );
    assert.ok(result !== null, 'gate fires on match');
  });

  test('equals predicate: does NOT fire when value differs', () => {
    const result = evaluateResponseNotApplicableGate(
      { context_key: 'status', predicate: { equals: 'done' } },
      { status: 'pending' }
    );
    assert.equal(result, null, 'gate does not fire on mismatch');
  });

  test('equals predicate: fires on boolean true', () => {
    const result = evaluateResponseNotApplicableGate(
      { context_key: 'has_more', predicate: { equals: false } },
      { has_more: false }
    );
    assert.ok(result !== null, 'gate fires on boolean equals');
  });

  test('equals predicate: does NOT fire on absent key', () => {
    const result = evaluateResponseNotApplicableGate({ context_key: 'status', predicate: { equals: 'done' } }, {});
    assert.equal(result, null, 'undefined !== "done"');
  });

  test('custom reason appears in output when gate fires', () => {
    const result = evaluateResponseNotApplicableGate(
      {
        context_key: 'cursor',
        predicate: 'absent',
        reason: 'single_page_result: list_accounts response is terminal; cursor-walk not applicable',
      },
      {}
    );
    assert.ok(result !== null);
    assert.ok(result.includes('single_page_result'), `detail should contain custom reason: ${result}`);
    assert.ok(result.includes('cursor-walk not applicable'), `detail should contain custom reason: ${result}`);
  });

  test('default reason references context_key when no custom reason', () => {
    const result = evaluateResponseNotApplicableGate({ context_key: 'my_cursor', predicate: 'absent' }, {});
    assert.ok(result !== null);
    assert.ok(result.includes('my_cursor'), `detail references key: ${result}`);
  });

  test('unknown predicate shape returns null (fail-open)', () => {
    const result = evaluateResponseNotApplicableGate({ context_key: 'x', predicate: 'unknown_future_predicate' }, {});
    assert.equal(result, null, 'unknown predicate fails open (phase runs)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests via runStoryboard with _client injection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a mock client that returns a canned response for every call.
 * The storyboard runner calls the client's tool methods; we return
 * whatever response the test needs.
 */
function makeMockClient(responsesByTask) {
  return {
    // Duck-typed AgentClient surface the runner uses.
    resetContext: () => {},
    call: async (task, _params) => {
      const response = responsesByTask[task];
      if (!response) throw new Error(`Unexpected task call: ${task}`);
      return { success: true, data: response };
    },
    // Minimal profile so discovery succeeds.
    _mock: true,
  };
}

/**
 * Minimal storyboard that models a two-phase pagination check:
 *   Phase 1 (setup): call list_accounts, capture pagination.cursor
 *   Phase 2 (cursor_walk): walk the cursor — gates on cursor being present
 *
 * This is a simplified in-test analog of the real pagination_integrity
 * storyboard; we use it to verify the gate mechanism without needing the
 * compliance cache.
 */
const paginationStoryboard = {
  id: 'pagination_integrity_test',
  version: '1.0.0',
  title: 'Pagination integrity (gate test)',
  category: 'test',
  summary: 'Verifies cursor-walk phase gates on prior response.',
  narrative: '',
  agent: { interaction_model: 'sync', capabilities: [] },
  caller: { role: 'buyer_agent' },
  phases: [
    {
      id: 'setup',
      title: 'First page',
      steps: [
        {
          id: 'first_page',
          title: 'Call list_accounts (first page)',
          task: 'list_accounts',
          sample_request: { pagination: { max_results: 2 } },
          stateful: false,
          context_outputs: [{ path: 'pagination.cursor', key: 'page1_cursor' }],
        },
      ],
    },
    {
      id: 'cursor_walk',
      title: 'Cursor walk',
      not_applicable_if_response: {
        context_key: 'page1_cursor',
        predicate: 'absent',
        reason: 'single_page_result: list_accounts response is terminal; cursor-walk not applicable',
      },
      steps: [
        {
          id: 'second_page',
          title: 'Call list_accounts (second page)',
          task: 'list_accounts',
          sample_request: { pagination: { max_results: 2, cursor: '$context.page1_cursor' } },
          stateful: false,
        },
      ],
    },
  ],
};

// Profile that advertises list_accounts so the tool-gate passes.
const mockProfile = {
  name: 'Mock seller',
  tools: ['list_accounts'],
  raw_capabilities: {},
};

describe('response-derived not_applicable gate integration (#1959)', () => {
  test('cursor-walk phase is not_applicable when pagination is absent from first response', async () => {
    // Single-account seller returns no pagination block.
    const client = makeMockClient({
      list_accounts: { accounts: [{ account_id: 'acc-1', name: 'Acme' }] },
    });

    const result = await runStoryboard('http://fake-99999', paginationStoryboard, {
      _client: client,
      _profile: mockProfile,
      agentTools: mockProfile.tools,
    });

    // Overall passes (not_applicable is not a failure).
    assert.equal(result.overall_passed, true);
    assert.equal(result.failed_count, 0);

    // Setup phase ran and passed.
    const setupPhase = result.phases.find(p => p.phase_id === 'setup');
    assert.ok(setupPhase, 'setup phase present');
    assert.equal(setupPhase.passed, true);
    assert.equal(setupPhase.steps.length, 1);
    assert.equal(setupPhase.steps[0].passed, true);
    assert.equal(setupPhase.steps[0].skipped, undefined);

    // Cursor-walk phase is not_applicable (all steps skipped).
    const walkPhase = result.phases.find(p => p.phase_id === 'cursor_walk');
    assert.ok(walkPhase, 'cursor_walk phase present');
    assert.equal(walkPhase.passed, true);
    assert.equal(walkPhase.steps.length, 1);
    const walkStep = walkPhase.steps[0];
    assert.equal(walkStep.passed, true, 'not_applicable is passed:true');
    assert.equal(walkStep.skipped, true, 'not_applicable is skipped:true');
    assert.equal(walkStep.skip_reason, 'not_applicable');
    assert.ok(
      walkStep.skip.detail.includes('single_page_result'),
      `detail should contain custom reason: ${walkStep.skip.detail}`
    );
    assert.ok(walkStep.skip.detail.includes('cursor-walk not applicable'), `detail: ${walkStep.skip.detail}`);

    // skipped_count incremented for the walk step.
    assert.equal(result.skipped_count, 1);
  });

  test('cursor-walk phase runs normally when first page has a cursor', async () => {
    // Multi-page seller returns a cursor on the first page.
    const client = makeMockClient({
      list_accounts: {
        accounts: [
          { account_id: 'acc-1', name: 'Acme' },
          { account_id: 'acc-2', name: 'Beta' },
        ],
        pagination: { has_more: true, cursor: 'cursor-abc' },
      },
    });

    const result = await runStoryboard('http://fake-99999', paginationStoryboard, {
      _client: client,
      _profile: mockProfile,
      agentTools: mockProfile.tools,
    });

    // Cursor-walk phase ran (skipped_count is 0 from the gate; the second
    // list_accounts call returns the same response, which is fine for this
    // structural test — we just need to verify the gate didn't suppress the phase).
    const walkPhase = result.phases.find(p => p.phase_id === 'cursor_walk');
    assert.ok(walkPhase, 'cursor_walk phase present');
    // The phase steps executed (not gate-skipped). Steps may pass or fail
    // depending on validations, but they were not suppressed by the gate.
    assert.equal(walkPhase.steps.length, 1);
    // Step is not skipped by the gate (it may have been skipped for other
    // reasons such as context substitution, but skip_reason won't be not_applicable
    // from the gate).
    if (walkPhase.steps[0].skipped) {
      assert.notEqual(
        walkPhase.steps[0].skip_reason,
        'not_applicable',
        'if skipped, it was not suppressed by the response gate'
      );
    }
  });

  test('gate does not fire when predicate does not match (present predicate, key absent)', async () => {
    const storyboardWithPresentGate = {
      ...paginationStoryboard,
      phases: [
        paginationStoryboard.phases[0],
        {
          ...paginationStoryboard.phases[1],
          not_applicable_if_response: {
            context_key: 'page1_cursor',
            predicate: 'present', // gate fires only when cursor IS present
            reason: 'cursor present — test gate',
          },
        },
      ],
    };

    // Seller returns no cursor — gate should NOT fire for 'present' predicate.
    const client = makeMockClient({
      list_accounts: { accounts: [{ account_id: 'acc-1', name: 'Acme' }] },
    });

    const result = await runStoryboard('http://fake-99999', storyboardWithPresentGate, {
      _client: client,
      _profile: mockProfile,
      agentTools: mockProfile.tools,
    });

    const walkPhase = result.phases.find(p => p.phase_id === 'cursor_walk');
    assert.ok(walkPhase, 'cursor_walk phase present');
    // Gate did not fire (cursor absent, predicate=present → gate does not fire).
    // Step was executed, not gate-suppressed.
    if (walkPhase.steps[0].skipped) {
      assert.notEqual(
        walkPhase.steps[0].skip_reason,
        'not_applicable',
        'present predicate did not fire when key was absent'
      );
    }
  });

  test('phase without gate is unaffected', async () => {
    // A plain storyboard with no not_applicable_if_response field.
    const plainStoryboard = {
      ...paginationStoryboard,
      phases: paginationStoryboard.phases.map(p => {
        const { not_applicable_if_response: _, ...rest } = p;
        return rest;
      }),
    };

    const client = makeMockClient({
      list_accounts: { accounts: [{ account_id: 'acc-1', name: 'Acme' }] },
    });

    const result = await runStoryboard('http://fake-99999', plainStoryboard, {
      _client: client,
      _profile: mockProfile,
      agentTools: mockProfile.tools,
    });

    // Both phases ran; no gate-induced skips.
    assert.equal(result.phases.length, 2);
    // Walk phase ran (may fail or pass, but wasn't suppressed by a gate).
    const walkPhase = result.phases.find(p => p.phase_id === 'cursor_walk');
    if (walkPhase?.steps[0]?.skipped) {
      assert.notEqual(walkPhase.steps[0].skip_reason, 'not_applicable');
    }
  });
});
