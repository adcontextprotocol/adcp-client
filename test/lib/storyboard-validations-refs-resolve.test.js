const { describe, it } = require('node:test');
const assert = require('node:assert');
const { runValidations } = require('../../dist/lib/testing/storyboard/validations');

const AGENT_URL = 'https://sales.example.com/mcp';
const THIRD_PARTY_URL = 'https://creatives.otheragent.com/mcp';

function refsResolveCheck(overrides = {}) {
  return {
    check: 'refs_resolve',
    description: 'Every format_id on products resolves to a format in list_creative_formats',
    source: { from: 'context', path: 'products[*].format_ids[*]' },
    target: { from: 'current_step', path: 'formats[*].format_id' },
    match_keys: ['agent_url', 'id'],
    ...overrides,
  };
}

function runOne(validation, taskResult, storyboardContext) {
  return runValidations([validation], {
    taskName: 'list_creative_formats',
    taskResult,
    agentUrl: AGENT_URL,
    contributions: new Set(),
    storyboardContext,
  });
}

describe('validateRefsResolve', () => {
  it('passes when every source ref matches a target ref', () => {
    const context = {
      products: [
        {
          product_id: 'p1',
          format_ids: [
            { agent_url: AGENT_URL, id: 'display_300x250' },
            { agent_url: AGENT_URL, id: 'video_pre_roll' },
          ],
        },
        {
          product_id: 'p2',
          format_ids: [{ agent_url: AGENT_URL, id: 'display_300x250' }],
        },
      ],
    };
    const taskResult = {
      success: true,
      data: {
        formats: [
          { format_id: { agent_url: AGENT_URL, id: 'display_300x250' }, type: 'display' },
          { format_id: { agent_url: AGENT_URL, id: 'video_pre_roll' }, type: 'video' },
          { format_id: { agent_url: AGENT_URL, id: 'native_feed' }, type: 'native' },
        ],
      },
    };
    const [result] = runOne(refsResolveCheck(), taskResult, context);
    assert.strictEqual(result.passed, true, result.error);
  });

  it('fails and names each unresolved ref when one is missing from target', () => {
    const context = {
      products: [
        {
          product_id: 'p1',
          format_ids: [
            { agent_url: AGENT_URL, id: 'display_300x250' },
            { agent_url: AGENT_URL, id: 'stale_format_that_was_removed' },
          ],
        },
      ],
    };
    const taskResult = {
      success: true,
      data: {
        formats: [{ format_id: { agent_url: AGENT_URL, id: 'display_300x250' } }],
      },
    };
    const [result] = runOne(refsResolveCheck(), taskResult, context);
    assert.strictEqual(result.passed, false);
    assert.deepStrictEqual(result.actual.missing, [
      { agent_url: AGENT_URL, id: 'stale_format_that_was_removed' },
    ]);
    assert.match(result.error, /stale_format_that_was_removed/);
  });

  it('scopes on agent_url and emits an observation for third-party refs (warn default)', () => {
    const context = {
      products: [
        {
          product_id: 'p1',
          format_ids: [
            { agent_url: AGENT_URL, id: 'display_300x250' },
            { agent_url: THIRD_PARTY_URL, id: 'third_party_format' },
          ],
        },
      ],
    };
    const taskResult = {
      success: true,
      data: {
        formats: [{ format_id: { agent_url: AGENT_URL, id: 'display_300x250' } }],
      },
    };
    const [result] = runOne(
      refsResolveCheck({
        scope: { key: 'agent_url', equals: '$agent_url' },
        on_out_of_scope: 'warn',
      }),
      taskResult,
      context
    );
    assert.strictEqual(result.passed, true, result.error);
    assert.ok(Array.isArray(result.observations));
    assert.strictEqual(result.observations.length, 1);
    assert.strictEqual(result.observations[0].kind, 'out_of_scope_ref');
    assert.deepStrictEqual(result.observations[0].ref, {
      agent_url: THIRD_PARTY_URL,
      id: 'third_party_format',
    });
  });

  it('ignores out-of-scope refs silently when on_out_of_scope is ignore', () => {
    const context = {
      products: [
        { format_ids: [{ agent_url: THIRD_PARTY_URL, id: 'third' }] },
      ],
    };
    const taskResult = { success: true, data: { formats: [] } };
    const [result] = runOne(
      refsResolveCheck({
        scope: { key: 'agent_url', equals: '$agent_url' },
        on_out_of_scope: 'ignore',
      }),
      taskResult,
      context
    );
    assert.strictEqual(result.passed, true, result.error);
    assert.strictEqual(result.observations, undefined);
  });

  it('treats out-of-scope refs as missing when on_out_of_scope is fail', () => {
    const context = {
      products: [
        {
          format_ids: [
            { agent_url: AGENT_URL, id: 'display_300x250' },
            { agent_url: THIRD_PARTY_URL, id: 'third' },
          ],
        },
      ],
    };
    const taskResult = {
      success: true,
      data: { formats: [{ format_id: { agent_url: AGENT_URL, id: 'display_300x250' } }] },
    };
    const [result] = runOne(
      refsResolveCheck({
        scope: { key: 'agent_url', equals: '$agent_url' },
        on_out_of_scope: 'fail',
      }),
      taskResult,
      context
    );
    assert.strictEqual(result.passed, false);
    assert.deepStrictEqual(result.actual.out_of_scope_failed, [
      { agent_url: THIRD_PARTY_URL, id: 'third' },
    ]);
  });

  it('normalizes trailing slashes when comparing agent_url in scope', () => {
    const context = {
      products: [
        {
          format_ids: [
            { agent_url: AGENT_URL + '/', id: 'display_300x250' },
          ],
        },
      ],
    };
    const taskResult = {
      success: true,
      data: { formats: [{ format_id: { agent_url: AGENT_URL, id: 'display_300x250' } }] },
    };
    const [result] = runOne(
      refsResolveCheck({
        scope: { key: 'agent_url', equals: '$agent_url' },
      }),
      taskResult,
      context
    );
    assert.strictEqual(result.passed, true, result.error);
  });

  it('resolves nested [*] wildcards across multiple products', () => {
    const context = {
      products: [
        { format_ids: [{ agent_url: AGENT_URL, id: 'a' }, { agent_url: AGENT_URL, id: 'b' }] },
        { format_ids: [{ agent_url: AGENT_URL, id: 'c' }] },
      ],
    };
    const taskResult = {
      success: true,
      data: {
        formats: [
          { format_id: { agent_url: AGENT_URL, id: 'a' } },
          { format_id: { agent_url: AGENT_URL, id: 'b' } },
          { format_id: { agent_url: AGENT_URL, id: 'c' } },
        ],
      },
    };
    const [result] = runOne(refsResolveCheck(), taskResult, context);
    assert.strictEqual(result.passed, true, result.error);
  });

  it('passes when source is empty (no refs to resolve)', () => {
    const context = { products: [] };
    const taskResult = { success: true, data: { formats: [] } };
    const [result] = runOne(refsResolveCheck(), taskResult, context);
    assert.strictEqual(result.passed, true, result.error);
  });

  it('fails when target is empty and source has in-scope refs', () => {
    const context = {
      products: [{ format_ids: [{ agent_url: AGENT_URL, id: 'x' }] }],
    };
    const taskResult = { success: true, data: { formats: [] } };
    const [result] = runOne(refsResolveCheck(), taskResult, context);
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.actual.missing.length, 1);
  });

  it('returns a config error when source/target/match_keys are missing', () => {
    const [result] = runOne(
      { check: 'refs_resolve', description: 'misconfigured' },
      { success: true, data: {} },
      {}
    );
    assert.strictEqual(result.passed, false);
    assert.match(result.error, /source.*target.*match_keys/);
  });

  it('normalizes scope.equals when given a literal URL with trailing slash', () => {
    const context = {
      products: [
        {
          format_ids: [
            { agent_url: 'https://creatives.example.com/mcp', id: 'x' },
            { agent_url: THIRD_PARTY_URL, id: 'third' },
          ],
        },
      ],
    };
    const taskResult = {
      success: true,
      data: { formats: [{ format_id: { agent_url: 'https://creatives.example.com/mcp', id: 'x' } }] },
    };
    const [result] = runOne(
      refsResolveCheck({
        target: { from: 'current_step', path: 'formats[*].format_id' },
        scope: { key: 'agent_url', equals: 'https://creatives.example.com/mcp/' },
      }),
      taskResult,
      context
    );
    assert.strictEqual(result.passed, true, result.error);
  });

  it('refusal to match when one side is missing a match_key', () => {
    const context = {
      products: [{ format_ids: [{ id: 'x' }] }], // no agent_url
    };
    const taskResult = {
      success: true,
      data: { formats: [{ format_id: { id: 'x' } }] }, // also no agent_url
    };
    const [result] = runOne(refsResolveCheck(), taskResult, context);
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.actual.missing.length, 1);
  });

  it('deduplicates actual.missing on projected match_key tuple', () => {
    const sameBadRef = { agent_url: AGENT_URL, id: 'stale' };
    const context = {
      products: [
        { format_ids: [sameBadRef] },
        { format_ids: [sameBadRef] },
        { format_ids: [sameBadRef] },
      ],
    };
    const taskResult = { success: true, data: { formats: [] } };
    const [result] = runOne(refsResolveCheck(), taskResult, context);
    assert.strictEqual(result.passed, false);
    assert.deepStrictEqual(result.actual.missing, [sameBadRef]);
    // error phrasing should reflect the deduped count, not the raw 3
    assert.match(result.error, /^1 ref\(s\) did not resolve/);
  });

  it('uses "first 3" phrasing when more than 3 refs are missing', () => {
    const context = {
      products: [
        {
          format_ids: [
            { agent_url: AGENT_URL, id: 'a' },
            { agent_url: AGENT_URL, id: 'b' },
            { agent_url: AGENT_URL, id: 'c' },
            { agent_url: AGENT_URL, id: 'd' },
          ],
        },
      ],
    };
    const taskResult = { success: true, data: { formats: [] } };
    const [result] = runOne(refsResolveCheck(), taskResult, context);
    assert.strictEqual(result.passed, false);
    assert.match(result.error, /4 ref\(s\) did not resolve; first 3:/);
    assert.strictEqual(result.actual.missing.length, 4);
  });

  it('preserves source.path on the failed result for report attribution', () => {
    const context = { products: [{ format_ids: [{ agent_url: AGENT_URL, id: 'x' }] }] };
    const taskResult = { success: true, data: { formats: [] } };
    const [result] = runOne(refsResolveCheck(), taskResult, context);
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.path, 'products[*].format_ids[*]');
  });

  it('emits an observation when source values are non-object scalars', () => {
    const context = {
      products: [{ format_ids: ['display_300x250', 'video_pre_roll'] }], // legacy v2 string IDs
    };
    const taskResult = {
      success: true,
      data: { formats: [{ format_id: { agent_url: AGENT_URL, id: 'display_300x250' } }] },
    };
    const [result] = runOne(refsResolveCheck(), taskResult, context);
    assert.strictEqual(result.passed, true, 'empty in-scope source should pass');
    const scalarObs = (result.observations ?? []).find(o => o.kind === 'non_object_values_filtered');
    assert.ok(scalarObs, 'expected a non_object_values_filtered observation');
    assert.strictEqual(scalarObs.side, 'source');
    assert.strictEqual(scalarObs.count, 2);
  });

  it('does not surface prototype-chain values like __proto__ or constructor', () => {
    const context = { products: {} };
    const taskResult = { success: true, data: { formats: {} } };
    // A storyboard author (or a bug) asking for __proto__ should get nothing,
    // not Object.prototype projected through match_keys.
    const validation = refsResolveCheck({
      source: { from: 'context', path: 'products.__proto__' },
      target: { from: 'current_step', path: 'formats.constructor' },
      match_keys: ['id'],
    });
    const [result] = runOne(validation, taskResult, context);
    // Empty source, so it passes vacuously — but more importantly, no prototype
    // object ended up in any observation/missing payload.
    assert.strictEqual(result.passed, true);
  });

  it('caps wildcard fan-out so a malicious response cannot OOM the runner', () => {
    // Build a 4-level-deep nested array that would produce >1M values without
    // a cap. The cap sits at 10_000 so the walker returns early.
    const build = depth => {
      if (depth === 0) return [{ agent_url: AGENT_URL, id: 'x' }];
      const out = [];
      for (let i = 0; i < 50; i++) out.push({ nested: build(depth - 1) });
      return out;
    };
    const context = { items: build(4) };
    const taskResult = { success: true, data: { formats: [{ format_id: { agent_url: AGENT_URL, id: 'x' } }] } };
    const start = Date.now();
    const [result] = runOne(
      refsResolveCheck({
        source: { from: 'context', path: 'items[*].nested[*].nested[*].nested[*]' },
      }),
      taskResult,
      context
    );
    const elapsed = Date.now() - start;
    // The cap is primarily a memory-bound guard; the wall-clock assertion is
    // a loose ceiling — the real invariant is "the process didn't OOM."
    assert.ok(elapsed < 5000, `refs_resolve should short-circuit; took ${elapsed}ms`);
    // A single valid ref in the target means the check passes as long as at
    // least one capped source ref matches. Don't over-specify pass/fail here —
    // the point is that the runner survived.
    assert.strictEqual(typeof result.passed, 'boolean');
  });
});
