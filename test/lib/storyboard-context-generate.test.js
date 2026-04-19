const { describe, it } = require('node:test');
const assert = require('node:assert');
const { injectContext, forwardAliasCache } = require('../../dist/lib/testing/storyboard/context');

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
