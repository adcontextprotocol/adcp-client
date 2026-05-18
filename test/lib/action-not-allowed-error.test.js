// Tests for ActionNotAllowedError landed for AdCP 3.1 / RFC #4480.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  ActionNotAllowedError,
  adcpErrorToTypedError,
  isADCPError,
  isErrorOfType,
} = require('../../dist/lib/errors');

describe('ActionNotAllowedError', () => {
  test('parses typed details and exposes structured fields', () => {
    const err = new ActionNotAllowedError({
      attempted_action: 'extend_flight',
      reason: 'wrong_status',
      currently_available_actions: [{ action: 'pause', mode: 'self_serve' }],
    });
    assert.strictEqual(err.code, 'ACTION_NOT_ALLOWED');
    assert.strictEqual(err.attemptedAction, 'extend_flight');
    assert.strictEqual(err.reason, 'wrong_status');
    assert.strictEqual(err.currentlyAvailableActions.length, 1);
    assert.strictEqual(err.recovery, undefined);
    assert.ok(err.message.includes('extend_flight'));
    assert.ok(err.message.includes('wrong_status'));
  });

  test('mode_mismatch with requires_proposal yields createProposal recovery', () => {
    const err = new ActionNotAllowedError({
      attempted_action: 'increase_budget',
      reason: 'mode_mismatch',
      currently_available_actions: [
        { action: 'increase_budget', mode: 'requires_proposal' },
      ],
    });
    assert.ok(err.recovery);
    assert.strictEqual(err.recovery.kind, 'createProposal');
    assert.match(err.recovery.message, /create_proposal/);
  });

  test('mode_mismatch with requires_approval yields waitForApproval recovery', () => {
    const err = new ActionNotAllowedError({
      attempted_action: 'cancel',
      reason: 'mode_mismatch',
      currently_available_actions: [{ action: 'cancel', mode: 'requires_approval' }],
    });
    assert.strictEqual(err.recovery.kind, 'waitForApproval');
  });

  test('mode_mismatch with conditional_self_serve yields reissueAsDirect', () => {
    const err = new ActionNotAllowedError({
      attempted_action: 'pause',
      reason: 'mode_mismatch',
      currently_available_actions: [{ action: 'pause', mode: 'conditional_self_serve' }],
    });
    assert.strictEqual(err.recovery.kind, 'reissueAsDirect');
  });

  test('not_supported_on_product produces terminal-style message', () => {
    const err = new ActionNotAllowedError({
      attempted_action: 'remove_creative',
      reason: 'not_supported_on_product',
    });
    assert.match(err.message, /pick a different product/);
  });

  test('not_supported_on_buy produces renegotiation message', () => {
    const err = new ActionNotAllowedError({
      attempted_action: 'add_packages',
      reason: 'not_supported_on_buy',
    });
    assert.match(err.message, /renegotiate buy terms/);
  });

  test('is detected by isADCPError / isErrorOfType', () => {
    const err = new ActionNotAllowedError({
      attempted_action: 'pause',
      reason: 'wrong_status',
    });
    assert.strictEqual(isADCPError(err), true);
    assert.strictEqual(isErrorOfType(err, ActionNotAllowedError), true);
  });
});

describe('adcpErrorToTypedError dispatch', () => {
  test('maps ACTION_NOT_ALLOWED code with typed details to ActionNotAllowedError', () => {
    const typed = adcpErrorToTypedError({
      code: 'ACTION_NOT_ALLOWED',
      message: 'Action not allowed',
      details: {
        attempted_action: 'increase_budget',
        reason: 'mode_mismatch',
        currently_available_actions: [
          { action: 'increase_budget', mode: 'requires_proposal' },
        ],
      },
    });
    assert.ok(typed instanceof ActionNotAllowedError);
    assert.strictEqual(typed.attemptedAction, 'increase_budget');
    assert.strictEqual(typed.recovery.kind, 'createProposal');
  });

  test('returns undefined for malformed details', () => {
    const typed = adcpErrorToTypedError({
      code: 'ACTION_NOT_ALLOWED',
      details: { attempted_action: 'pause' }, // missing reason
    });
    assert.strictEqual(typed, undefined);
  });

  test('rejects unknown reason values', () => {
    const typed = adcpErrorToTypedError({
      code: 'ACTION_NOT_ALLOWED',
      details: { attempted_action: 'pause', reason: 'made_up' },
    });
    assert.strictEqual(typed, undefined);
  });

  test('filters out malformed currently_available_actions entries', () => {
    const typed = adcpErrorToTypedError({
      code: 'ACTION_NOT_ALLOWED',
      details: {
        attempted_action: 'pause',
        reason: 'wrong_status',
        currently_available_actions: [
          { action: 'resume', mode: 'self_serve' },
          { action: 'cancel', mode: 'made_up_mode' }, // dropped
          { not_an_entry: true }, // dropped
        ],
      },
    });
    assert.ok(typed instanceof ActionNotAllowedError);
    assert.strictEqual(typed.currentlyAvailableActions.length, 1);
    assert.strictEqual(typed.currentlyAvailableActions[0].action, 'resume');
  });
});
