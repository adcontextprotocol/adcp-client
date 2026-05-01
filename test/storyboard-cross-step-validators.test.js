'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { runValidations } = require('../dist/lib/testing/storyboard/validations.js');

function makeCtx({ data, storyboardContext } = {}) {
  return {
    taskName: 'get_media_buys',
    agentUrl: 'https://example.com/mcp',
    contributions: new Set(),
    taskResult: { success: true, data: data ?? {} },
    storyboardContext: storyboardContext,
  };
}

// ────────────────────────────────────────────────────────────
// field_less_than
// ────────────────────────────────────────────────────────────

describe('field_less_than', () => {
  it('passes when field is strictly less than literal value', () => {
    const [result] = runValidations(
      [{ check: 'field_less_than', path: 'price', value: 100, description: 'price under cap' }],
      makeCtx({ data: { price: 50 } })
    );
    assert.strictEqual(result.passed, true);
  });

  it('fails when field equals the literal value (strict less-than)', () => {
    const [result] = runValidations(
      [{ check: 'field_less_than', path: 'price', value: 50, description: 'price under cap' }],
      makeCtx({ data: { price: 50 } })
    );
    assert.strictEqual(result.passed, false);
    assert.match(result.error, /50.*<.*50/);
  });

  it('fails when field is greater than the literal value', () => {
    const [result] = runValidations(
      [{ check: 'field_less_than', path: 'price', value: 30, description: 'price under cap' }],
      makeCtx({ data: { price: 50 } })
    );
    assert.strictEqual(result.passed, false);
  });

  it('passes using context_key comparand from storyboard context', () => {
    const [result] = runValidations(
      [{ check: 'field_less_than', path: 'cpm', context_key: 'floor_cpm', description: 'cpm above floor' }],
      makeCtx({ data: { cpm: 5 }, storyboardContext: { floor_cpm: 10 } })
    );
    assert.strictEqual(result.passed, true);
  });

  it('fails when field >= context_key comparand', () => {
    const [result] = runValidations(
      [{ check: 'field_less_than', path: 'cpm', context_key: 'floor_cpm', description: 'cpm above floor' }],
      makeCtx({ data: { cpm: 10 }, storyboardContext: { floor_cpm: 10 } })
    );
    assert.strictEqual(result.passed, false);
  });

  it('passes with observation when context_key is absent from storyboardContext', () => {
    const [result] = runValidations(
      [{ check: 'field_less_than', path: 'cpm', context_key: 'missing_key', description: 'test' }],
      makeCtx({ data: { cpm: 5 }, storyboardContext: {} })
    );
    assert.strictEqual(result.passed, true);
    assert.ok(Array.isArray(result.observations), 'should emit observations');
    assert.ok(result.observations[0].includes('context_key_absent'));
  });

  it('passes with observation when storyboardContext itself is undefined', () => {
    const [result] = runValidations(
      [{ check: 'field_less_than', path: 'cpm', context_key: 'floor_cpm', description: 'test' }],
      makeCtx({ data: { cpm: 5 }, storyboardContext: undefined })
    );
    assert.strictEqual(result.passed, true);
    assert.ok(Array.isArray(result.observations));
    assert.ok(result.observations[0].includes('context_key_absent'));
  });

  it('fails with type error when field is absent', () => {
    const [result] = runValidations(
      [{ check: 'field_less_than', path: 'nonexistent', value: 100, description: 'test' }],
      makeCtx({ data: { price: 50 } })
    );
    assert.strictEqual(result.passed, false);
    assert.ok(result.error.includes('not found'), `unexpected error: ${result.error}`);
  });

  it('fails with type error when field is non-numeric', () => {
    const [result] = runValidations(
      [{ check: 'field_less_than', path: 'status', value: 100, description: 'test' }],
      makeCtx({ data: { status: 'active' } })
    );
    assert.strictEqual(result.passed, false);
    assert.ok(result.error.includes('finite number'), `unexpected error: ${result.error}`);
  });

  it('fails with type error when comparand is non-numeric', () => {
    const [result] = runValidations(
      [{ check: 'field_less_than', path: 'price', value: 'expensive', description: 'test' }],
      makeCtx({ data: { price: 50 } })
    );
    assert.strictEqual(result.passed, false);
    assert.ok(result.error.includes('finite number'), `unexpected error: ${result.error}`);
  });

  it('fails when no path is specified', () => {
    const [result] = runValidations(
      [{ check: 'field_less_than', value: 100, description: 'test' }],
      makeCtx({ data: {} })
    );
    assert.strictEqual(result.passed, false);
    assert.ok(result.error.includes('path'));
  });
});

// ────────────────────────────────────────────────────────────
// field_equals_context
// ────────────────────────────────────────────────────────────

describe('field_equals_context', () => {
  it('passes when field matches the context value', () => {
    const [result] = runValidations(
      [{ check: 'field_equals_context', path: 'media_buy_id', context_key: 'media_buy_id', description: 'id echoed' }],
      makeCtx({ data: { media_buy_id: 'buy_123' }, storyboardContext: { media_buy_id: 'buy_123' } })
    );
    assert.strictEqual(result.passed, true);
  });

  it('fails when field does not match the context value', () => {
    const [result] = runValidations(
      [{ check: 'field_equals_context', path: 'media_buy_id', context_key: 'media_buy_id', description: 'id echoed' }],
      makeCtx({ data: { media_buy_id: 'buy_999' }, storyboardContext: { media_buy_id: 'buy_123' } })
    );
    assert.strictEqual(result.passed, false);
    assert.ok(result.error.includes('buy_123'));
    assert.ok(result.error.includes('buy_999'));
  });

  it('passes with observation when context_key is absent', () => {
    const [result] = runValidations(
      [{ check: 'field_equals_context', path: 'id', context_key: 'missing_key', description: 'test' }],
      makeCtx({ data: { id: 'abc' }, storyboardContext: {} })
    );
    assert.strictEqual(result.passed, true);
    assert.ok(Array.isArray(result.observations));
    assert.ok(result.observations[0].includes('context_key_absent'));
  });

  it('passes with observation when storyboardContext is undefined', () => {
    const [result] = runValidations(
      [{ check: 'field_equals_context', path: 'id', context_key: 'some_key', description: 'test' }],
      makeCtx({ data: { id: 'abc' }, storyboardContext: undefined })
    );
    assert.strictEqual(result.passed, true);
    assert.ok(Array.isArray(result.observations));
  });

  it('fails when no path is specified', () => {
    const [result] = runValidations(
      [{ check: 'field_equals_context', context_key: 'some_key', description: 'test' }],
      makeCtx({ data: {} })
    );
    assert.strictEqual(result.passed, false);
    assert.ok(result.error.includes('path'));
  });

  it('fails when no context_key is specified', () => {
    const [result] = runValidations(
      [{ check: 'field_equals_context', path: 'id', description: 'test' }],
      makeCtx({ data: { id: 'abc' } })
    );
    assert.strictEqual(result.passed, false);
    assert.ok(result.error.includes('context_key'));
  });

  it('deep-equals objects from context', () => {
    const [result] = runValidations(
      [{ check: 'field_equals_context', path: 'account', context_key: 'account', description: 'account matches' }],
      makeCtx({
        data: { account: { id: 'acc_1', name: 'Test' } },
        storyboardContext: { account: { id: 'acc_1', name: 'Test' } },
      })
    );
    assert.strictEqual(result.passed, true);
  });
});
