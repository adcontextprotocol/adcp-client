const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  injectContext,
  forwardAliasCache,
  extractContext,
  applyContextOutputsWithProvenance,
} = require('../../dist/lib/testing/storyboard/context');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('$generate:uuid_v4 placeholder resolution', () => {
  it('aliased placeholders resolve to the SAME UUID within a context', () => {
    const context = {};
    const a = injectContext({ idempotency_key: '$generate:uuid_v4#replay_key' }, context);
    const b = injectContext({ idempotency_key: '$generate:uuid_v4#replay_key' }, context);

    assert.match(a.idempotency_key, UUID);
    assert.strictEqual(a.idempotency_key, b.idempotency_key);
  });

  it('different aliases resolve to DIFFERENT UUIDs', () => {
    const context = {};
    const a = injectContext({ idempotency_key: '$generate:uuid_v4#key_a' }, context);
    const b = injectContext({ idempotency_key: '$generate:uuid_v4#key_b' }, context);

    assert.match(a.idempotency_key, UUID);
    assert.match(b.idempotency_key, UUID);
    assert.notStrictEqual(a.idempotency_key, b.idempotency_key);
  });

  it('bare (no-alias) placeholders each resolve to a FRESH UUID', () => {
    const context = {};
    const a = injectContext({ idempotency_key: '$generate:uuid_v4' }, context);
    const b = injectContext({ idempotency_key: '$generate:uuid_v4' }, context);

    assert.match(a.idempotency_key, UUID);
    assert.match(b.idempotency_key, UUID);
    assert.notStrictEqual(a.idempotency_key, b.idempotency_key);
  });

  it('placeholder does not leak implementation keys onto the context object', () => {
    // The alias cache lives in a WeakMap keyed off the context, not as a
    // property on the context itself. Serialized StoryboardResult output
    // must not carry implementation-detail keys.
    const context = {};
    injectContext({ idempotency_key: '$generate:uuid_v4#alias' }, context);

    assert.deepStrictEqual(Object.keys(context), []);
    assert.strictEqual(JSON.stringify(context), '{}');
  });

  it('unrecognized strings pass through unchanged', () => {
    const context = {};
    const out = injectContext({ field: 'not a placeholder' }, context);
    assert.strictEqual(out.field, 'not a placeholder');
  });

  it('forwardAliasCache propagates aliases across a shallow-cloned context', () => {
    // Simulates the runner's `updatedContext = { ...context }` step roll.
    // Without forwardAliasCache, replay tests where step 1 and step 2 share
    // an alias would silently resolve to different UUIDs.
    const ctx1 = {};
    const a = injectContext({ idempotency_key: '$generate:uuid_v4#replay_key' }, ctx1);

    const ctx2 = { ...ctx1 };
    forwardAliasCache(ctx1, ctx2);
    const b = injectContext({ idempotency_key: '$generate:uuid_v4#replay_key' }, ctx2);

    assert.strictEqual(a.idempotency_key, b.idempotency_key);
  });

  it('shallow-cloned context WITHOUT forwardAliasCache gets a fresh cache', () => {
    // Documents the design: context-following is opt-in. Storyboard runner
    // must call forwardAliasCache at every clone site. Silent drift here
    // would make replay tests fall back to fresh UUIDs without erroring.
    const ctx1 = {};
    const a = injectContext({ idempotency_key: '$generate:uuid_v4#replay_key' }, ctx1);

    const ctx2 = { ...ctx1 };
    // No forwardAliasCache — ctx2 gets its own cache.
    const b = injectContext({ idempotency_key: '$generate:uuid_v4#replay_key' }, ctx2);

    assert.notStrictEqual(a.idempotency_key, b.idempotency_key);
  });
});

describe('$generate:opaque_id placeholder resolution', () => {
  it('aliased opaque_id resolves to the SAME UUID within a context', () => {
    const context = {};
    const a = injectContext({ task_id: '$generate:opaque_id#directive_task_id' }, context);
    const b = injectContext({ task_id: '$generate:opaque_id#directive_task_id' }, context);

    assert.match(a.task_id, UUID);
    assert.strictEqual(a.task_id, b.task_id);
  });

  it('bare opaque_id and bare uuid_v4 each produce fresh UUIDs per call', () => {
    const context = {};
    const a = injectContext({ k: '$generate:opaque_id' }, context);
    const b = injectContext({ k: '$generate:opaque_id' }, context);

    assert.match(a.k, UUID);
    assert.match(b.k, UUID);
    assert.notStrictEqual(a.k, b.k);
  });

  it('opaque_id alias and uuid_v4 alias share the same cache namespace', () => {
    // A storyboard author can use either $generate:opaque_id#my_task or
    // $generate:uuid_v4#my_task interchangeably; both read from the same
    // alias cache slot under the same key name.
    const context = {};
    const a = injectContext({ task_id: '$generate:opaque_id#shared_key' }, context);
    const b = injectContext({ task_id: '$generate:uuid_v4#shared_key' }, context);

    assert.strictEqual(a.task_id, b.task_id);
  });
});

describe('context_outputs[generate] — applyContextOutputsWithProvenance', () => {
  it('mints a UUID and writes it into values under the declared key', () => {
    const context = {};
    const result = applyContextOutputsWithProvenance(
      null,
      [{ key: 'directive_task_id', generate: 'opaque_id' }],
      'step-arm',
      'comply_test_controller',
      context
    );

    assert.match(result.values.directive_task_id, UUID);
    assert.strictEqual(result.provenance.directive_task_id.source_kind, 'generator');
    assert.strictEqual(result.provenance.directive_task_id.source_step_id, 'step-arm');
    assert.strictEqual(result.provenance.directive_task_id.source_task, 'comply_test_controller');
    assert.strictEqual(result.provenance.directive_task_id.response_path, undefined);
  });

  it('reuses the alias-cache value when the same alias was resolved inline earlier', () => {
    // Simulates: step has $generate:opaque_id#directive_task_id in sample_request
    // AND context_outputs[{key: directive_task_id, generate: opaque_id}].
    // Both must resolve to the same UUID.
    const context = {};
    const inline = injectContext({ task_id: '$generate:opaque_id#directive_task_id' }, context);

    // Post-response: context_outputs[generate] fires against the same context.
    const result = applyContextOutputsWithProvenance(
      null,
      [{ key: 'directive_task_id', generate: 'opaque_id' }],
      'step-arm',
      'comply_test_controller',
      context
    );

    assert.strictEqual(result.values.directive_task_id, inline.task_id);
  });

  it('mints a fresh UUID when no prior inline substitution set the alias', () => {
    const context = {};
    const result = applyContextOutputsWithProvenance(
      null,
      [{ key: 'fresh_task_id', generate: 'opaque_id' }],
      'step-1',
      'comply_test_controller',
      context
    );

    assert.match(result.values.fresh_task_id, UUID);
  });

  it('two generate entries with different keys produce different UUIDs', () => {
    const context = {};
    const result = applyContextOutputsWithProvenance(
      null,
      [
        { key: 'task_a', generate: 'opaque_id' },
        { key: 'task_b', generate: 'opaque_id' },
      ],
      'step-1',
      'comply_test_controller',
      context
    );

    assert.match(result.values.task_a, UUID);
    assert.match(result.values.task_b, UUID);
    assert.notStrictEqual(result.values.task_a, result.values.task_b);
  });

  it('generate entry fires even when data is null (no-response step)', () => {
    const context = {};
    const result = applyContextOutputsWithProvenance(
      null,
      [{ key: 'my_task_id', generate: 'uuid_v4' }],
      'step-1',
      'comply_test_controller',
      context
    );

    assert.match(result.values.my_task_id, UUID);
  });

  it('path entry is skipped when data is null', () => {
    const context = {};
    const result = applyContextOutputsWithProvenance(
      null,
      [{ key: 'task_id', path: 'forced.task_id' }],
      'step-1',
      'comply_test_controller',
      context
    );

    assert.deepStrictEqual(result.values, {});
  });

  it('generated value is written into alias cache so forwardAliasCache propagates it', () => {
    const context = {};
    applyContextOutputsWithProvenance(
      null,
      [{ key: 'lifecycle_task_id', generate: 'opaque_id' }],
      'step-arm',
      'comply_test_controller',
      context
    );

    // Simulate runner's step-roll: shallow-clone + forwardAliasCache.
    const nextContext = { ...context };
    forwardAliasCache(context, nextContext);

    // A later step using $generate:opaque_id#lifecycle_task_id must
    // resolve to the same value that was generated by context_outputs.
    const later = injectContext({ task_id: '$generate:opaque_id#lifecycle_task_id' }, nextContext);
    const firstResult = applyContextOutputsWithProvenance(
      null,
      [{ key: 'lifecycle_task_id', generate: 'opaque_id' }],
      'step-arm',
      'comply_test_controller',
      context
    );

    assert.strictEqual(later.task_id, firstResult.values.lifecycle_task_id);
  });

  it('mixed path+generate outputs: both work in one call', () => {
    const context = {};
    const data = { forced: { task_id: 'seller-task-xyz' } };
    const result = applyContextOutputsWithProvenance(
      data,
      [
        { key: 'directive_task_id', generate: 'opaque_id' },
        { key: 'confirmed_task_id', path: 'forced.task_id' },
      ],
      'step-arm',
      'comply_test_controller',
      context
    );

    assert.match(result.values.directive_task_id, UUID);
    assert.strictEqual(result.values.confirmed_task_id, 'seller-task-xyz');
    assert.strictEqual(result.provenance.directive_task_id.source_kind, 'generator');
    assert.strictEqual(result.provenance.confirmed_task_id.source_kind, 'context_outputs');
  });
});

describe('extractContext – get_media_buys pagination guard', () => {
  it('returns {} when pagination.has_more is true (mid-walk page)', () => {
    const data = {
      media_buys: [{ media_buy_id: 'buy-1', status: 'active' }],
      pagination: { has_more: true, cursor: 'cursor-abc' },
    };
    assert.deepStrictEqual(extractContext('get_media_buys', data), {});
  });

  it('extracts media_buy_id when pagination.has_more is false (terminal page)', () => {
    const data = {
      media_buys: [{ media_buy_id: 'buy-1', status: 'active' }],
      pagination: { has_more: false },
    };
    const result = extractContext('get_media_buys', data);
    assert.strictEqual(result.media_buy_id, 'buy-1');
    assert.strictEqual(result.media_buy_status, 'active');
  });

  it('extracts media_buy_id when no pagination block present (single-resource response)', () => {
    const data = { media_buys: [{ media_buy_id: 'buy-2', status: 'pending' }] };
    const result = extractContext('get_media_buys', data);
    assert.strictEqual(result.media_buy_id, 'buy-2');
    assert.strictEqual(result.media_buy_status, 'pending');
  });

  it('returns {} when media_buys array is empty', () => {
    assert.deepStrictEqual(extractContext('get_media_buys', { media_buys: [] }), {});
  });
});
