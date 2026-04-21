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
    assert.deepStrictEqual(result.actual.missing, [{ agent_url: AGENT_URL, id: 'stale_format_that_was_removed' }]);
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
      products: [{ format_ids: [{ agent_url: THIRD_PARTY_URL, id: 'third' }] }],
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
    assert.deepStrictEqual(result.actual.out_of_scope_failed, [{ agent_url: THIRD_PARTY_URL, id: 'third' }]);
  });

  it('normalizes trailing slashes when comparing agent_url in scope', () => {
    const context = {
      products: [
        {
          format_ids: [{ agent_url: AGENT_URL + '/', id: 'display_300x250' }],
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
        {
          format_ids: [
            { agent_url: AGENT_URL, id: 'a' },
            { agent_url: AGENT_URL, id: 'b' },
          ],
        },
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
    const [result] = runOne({ check: 'refs_resolve', description: 'misconfigured' }, { success: true, data: {} }, {});
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
      products: [{ format_ids: [sameBadRef] }, { format_ids: [sameBadRef] }, { format_ids: [sameBadRef] }],
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

  // ──────────────────────────────────────────────────────────
  // #710: $agent_url canonicalization drops transport suffix
  // ──────────────────────────────────────────────────────────

  it('canonicalizes $agent_url to origin so /mcp transport suffix does not mismatch', () => {
    // Runner target URL carries /mcp; refs advertise bare origin. Both
    // sides must collapse to https://sales.example.com before compare.
    const BARE = 'https://sales.example.com';
    const context = {
      products: [
        {
          format_ids: [
            { agent_url: BARE, id: 'display_300x250' },
            { agent_url: BARE, id: 'video_pre_roll' },
          ],
        },
      ],
    };
    const taskResult = {
      success: true,
      data: {
        formats: [
          { format_id: { agent_url: BARE, id: 'display_300x250' } },
          { format_id: { agent_url: BARE, id: 'video_pre_roll' } },
        ],
      },
    };
    const [result] = runOne(
      refsResolveCheck({
        scope: { key: 'agent_url', equals: '$agent_url' },
        on_out_of_scope: 'fail',
      }),
      taskResult,
      context
    );
    assert.strictEqual(result.passed, true, result.error);
  });

  it('canonicalizes /a2a and trailing-slash transport paths identically', () => {
    const BARE = 'https://sales.example.com';
    const context = {
      products: [{ format_ids: [{ agent_url: BARE, id: 'a' }] }],
    };
    const taskResult = {
      success: true,
      data: { formats: [{ format_id: { agent_url: BARE, id: 'a' } }] },
    };
    // Agent URL with /a2a/ transport suffix and trailing slash.
    const [result] = runValidations(
      [refsResolveCheck({ scope: { key: 'agent_url', equals: '$agent_url' }, on_out_of_scope: 'fail' })],
      {
        taskName: 'list_creative_formats',
        taskResult,
        agentUrl: 'https://sales.example.com/a2a/',
        contributions: new Set(),
        storyboardContext: context,
      }
    );
    assert.strictEqual(result.passed, true, result.error);
  });

  it('canonicalizes default port and host case identically', () => {
    const context = {
      products: [{ format_ids: [{ agent_url: 'https://sales.example.com:443', id: 'a' }] }],
    };
    const taskResult = {
      success: true,
      data: { formats: [{ format_id: { agent_url: 'HTTPS://Sales.Example.com/mcp', id: 'a' } }] },
    };
    const [result] = runOne(
      refsResolveCheck({
        scope: { key: 'agent_url', equals: '$agent_url' },
        on_out_of_scope: 'fail',
      }),
      taskResult,
      context
    );
    assert.strictEqual(result.passed, true, result.error);
  });

  it('preserves subpath so sibling agents on a shared host do NOT collide', () => {
    // Per AdCP core/format-id.json, agent_url can legitimately live under a
    // subpath (e.g. https://publisher.com/.well-known/adcp/sales). Origin-only
    // canonicalization would false-positive two siblings on the same host;
    // path-preserving + transport-stripping must keep them distinct.
    const SIBLING_A = 'https://publisher.com/.well-known/adcp/sales';
    const SIBLING_B = 'https://publisher.com/.well-known/adcp/creative';
    const context = {
      products: [{ format_ids: [{ agent_url: SIBLING_B, id: 'x' }] }],
    };
    const taskResult = { success: true, data: { formats: [] } };
    // Runner points at sibling A with /mcp transport; sibling B's refs must
    // be classified out-of-scope, not in-scope.
    const [result] = runValidations(
      [refsResolveCheck({ scope: { key: 'agent_url', equals: '$agent_url' }, on_out_of_scope: 'warn' })],
      {
        taskName: 'list_creative_formats',
        taskResult,
        agentUrl: SIBLING_A + '/mcp',
        contributions: new Set(),
        storyboardContext: context,
      }
    );
    assert.strictEqual(result.passed, true);
    const outOfScope = (result.observations ?? []).find(o => o.kind === 'out_of_scope_ref');
    assert.ok(outOfScope, 'sibling on same host must classify out_of_scope');
    assert.strictEqual(outOfScope.ref.agent_url, SIBLING_B);
  });

  it('strips .well-known agent card path from canonical form', () => {
    const BARE = 'https://sales.example.com';
    const context = {
      products: [{ format_ids: [{ agent_url: BARE, id: 'a' }] }],
    };
    const taskResult = {
      success: true,
      data: { formats: [{ format_id: { agent_url: BARE, id: 'a' } }] },
    };
    const [result] = runValidations(
      [refsResolveCheck({ scope: { key: 'agent_url', equals: '$agent_url' }, on_out_of_scope: 'fail' })],
      {
        taskName: 'list_creative_formats',
        taskResult,
        agentUrl: 'https://sales.example.com/.well-known/agent.json',
        contributions: new Set(),
        storyboardContext: context,
      }
    );
    assert.strictEqual(result.passed, true, result.error);
  });

  // ──────────────────────────────────────────────────────────
  // #711: meta-warning when scope excludes 100% of refs
  // ──────────────────────────────────────────────────────────

  it('emits scope_excluded_all_refs when scope filter partitions every source ref out', () => {
    const context = {
      products: [
        {
          format_ids: [
            { agent_url: THIRD_PARTY_URL, id: 'third_1' },
            { agent_url: THIRD_PARTY_URL, id: 'third_2' },
          ],
        },
      ],
    };
    const taskResult = { success: true, data: { formats: [] } };
    const [result] = runOne(
      refsResolveCheck({
        scope: { key: 'agent_url', equals: '$agent_url' },
        on_out_of_scope: 'warn',
      }),
      taskResult,
      context
    );
    // Check passes (warn mode, nothing truly missing) but the meta-observation
    // makes the silent-no-op visible to graders.
    assert.strictEqual(result.passed, true, result.error);
    const meta = (result.observations ?? []).find(o => o.kind === 'scope_excluded_all_refs');
    assert.ok(meta, 'expected scope_excluded_all_refs meta-observation');
    assert.strictEqual(meta.count, 2);
    assert.strictEqual(meta.scope_key, 'agent_url');
  });

  it('does not emit scope_excluded_all_refs when at least one ref is in scope', () => {
    const context = {
      products: [
        {
          format_ids: [
            { agent_url: AGENT_URL, id: 'ok' },
            { agent_url: THIRD_PARTY_URL, id: 'third' },
          ],
        },
      ],
    };
    const taskResult = {
      success: true,
      data: { formats: [{ format_id: { agent_url: AGENT_URL, id: 'ok' } }] },
    };
    const [result] = runOne(
      refsResolveCheck({ scope: { key: 'agent_url', equals: '$agent_url' } }),
      taskResult,
      context
    );
    const meta = (result.observations ?? []).find(o => o.kind === 'scope_excluded_all_refs');
    assert.strictEqual(meta, undefined);
  });

  it('does not emit scope_excluded_all_refs when source is empty', () => {
    const context = { products: [] };
    const taskResult = { success: true, data: { formats: [] } };
    const [result] = runOne(
      refsResolveCheck({ scope: { key: 'agent_url', equals: '$agent_url' } }),
      taskResult,
      context
    );
    assert.strictEqual(result.observations, undefined);
  });

  // ──────────────────────────────────────────────────────────
  // #712: target_paginated observation
  // ──────────────────────────────────────────────────────────

  it('emits target_paginated observation when current-step target has pagination.has_more', () => {
    const context = {
      products: [{ format_ids: [{ agent_url: AGENT_URL, id: 'a' }] }],
    };
    const taskResult = {
      success: true,
      data: {
        formats: [{ format_id: { agent_url: AGENT_URL, id: 'a' } }],
        pagination: { has_more: true, cursor: 'opaque' },
      },
    };
    const [result] = runOne(refsResolveCheck(), taskResult, context);
    assert.strictEqual(result.passed, true, result.error);
    const meta = (result.observations ?? []).find(o => o.kind === 'target_paginated');
    assert.ok(meta, 'expected target_paginated observation');
  });

  it('does not emit target_paginated when pagination.has_more is false', () => {
    const context = {
      products: [{ format_ids: [{ agent_url: AGENT_URL, id: 'a' }] }],
    };
    const taskResult = {
      success: true,
      data: {
        formats: [{ format_id: { agent_url: AGENT_URL, id: 'a' } }],
        pagination: { has_more: false },
      },
    };
    const [result] = runOne(refsResolveCheck(), taskResult, context);
    assert.strictEqual(result.observations, undefined);
  });

  it('demotes unresolved refs to observations when target is paginated (no false-fail)', () => {
    // Seller paginates list_creative_formats; product references a format_id
    // that legitimately lives on a later page. Must pass (observation only).
    const context = {
      products: [
        {
          format_ids: [
            { agent_url: AGENT_URL, id: 'on_page_1' },
            { agent_url: AGENT_URL, id: 'on_page_2' },
          ],
        },
      ],
    };
    const taskResult = {
      success: true,
      data: {
        formats: [{ format_id: { agent_url: AGENT_URL, id: 'on_page_1' } }],
        pagination: { has_more: true, cursor: 'next' },
      },
    };
    const [result] = runOne(refsResolveCheck(), taskResult, context);
    assert.strictEqual(result.passed, true, 'paginated target must not false-fail');
    const demoted = (result.observations ?? []).find(o => o.kind === 'unresolved_with_pagination');
    assert.ok(demoted, 'expected unresolved_with_pagination observation for the page-2 ref');
    assert.deepStrictEqual(demoted.ref, { agent_url: AGENT_URL, id: 'on_page_2' });
  });

  it('does NOT check pagination when target.from is context', () => {
    // Pagination only applies to current_step reads. context targets are
    // aggregated from prior steps and are treated as complete.
    const context = {
      products: [{ format_ids: [{ agent_url: AGENT_URL, id: 'x' }] }],
      formats: [], // <-- target read from context
      pagination: { has_more: true }, // misplaced flag, must be ignored
    };
    const taskResult = { success: true, data: {} };
    const [result] = runOne(
      refsResolveCheck({
        target: { from: 'context', path: 'formats[*].format_id' },
      }),
      taskResult,
      context
    );
    const meta = (result.observations ?? []).find(o => o.kind === 'target_paginated');
    assert.strictEqual(meta, undefined, 'target_paginated must not fire for context targets');
  });

  it('suppresses scope_excluded_all_refs when on_out_of_scope is ignore', () => {
    // Regression test for the deliberate gating: ignore mode explicitly
    // opts out of scope-related warnings, so the meta-observation that
    // catches silent-no-ops must not fire either.
    const context = {
      products: [{ format_ids: [{ agent_url: THIRD_PARTY_URL, id: 'z' }] }],
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
    assert.strictEqual(result.observations, undefined);
  });

  // ──────────────────────────────────────────────────────────
  // #714: observations payload hygiene
  // ──────────────────────────────────────────────────────────

  it('strips userinfo from agent_url in observations', () => {
    const context = {
      products: [
        {
          format_ids: [{ agent_url: 'https://user:secret@attacker.example.com/mcp', id: 'x' }],
        },
      ],
    };
    const taskResult = { success: true, data: { formats: [] } };
    const [result] = runOne(
      refsResolveCheck({
        scope: { key: 'agent_url', equals: '$agent_url' },
        on_out_of_scope: 'warn',
      }),
      taskResult,
      context
    );
    const obs = (result.observations ?? []).find(o => o.kind === 'out_of_scope_ref');
    assert.ok(obs, 'expected out_of_scope_ref observation');
    assert.ok(!String(obs.ref.agent_url).includes('secret'), 'userinfo must be stripped');
    assert.ok(!String(obs.ref.agent_url).includes('user:'), 'userinfo must be stripped');
  });

  it('truncates oversized ref string fields with ellipsis', () => {
    const bigId = 'x'.repeat(2000);
    const context = {
      products: [{ format_ids: [{ agent_url: AGENT_URL, id: bigId }] }],
    };
    const taskResult = { success: true, data: { formats: [] } };
    const [result] = runOne(refsResolveCheck(), taskResult, context);
    assert.strictEqual(result.passed, false);
    const missingId = result.actual.missing[0].id;
    assert.ok(missingId.length <= 512, `id should be capped at 512 chars, was ${missingId.length}`);
    assert.ok(missingId.endsWith('…'), 'truncated strings should end with ellipsis');
  });

  it('caps observations array and emits observations_truncated marker', () => {
    // 60 distinct out-of-scope refs; cap should hold at 50 with a truncation marker.
    const manyRefs = [];
    for (let i = 0; i < 60; i++) {
      manyRefs.push({ agent_url: `https://other-${i}.example.com`, id: `f${i}` });
    }
    const context = { products: [{ format_ids: manyRefs }] };
    const taskResult = { success: true, data: { formats: [] } };
    const [result] = runOne(
      refsResolveCheck({
        scope: { key: 'agent_url', equals: '$agent_url' },
        on_out_of_scope: 'warn',
      }),
      taskResult,
      context
    );
    assert.ok(result.observations.length <= 50, `capped at 50, got ${result.observations.length}`);
    const truncation = result.observations.find(o => o.kind === 'observations_truncated');
    assert.ok(truncation, 'expected observations_truncated marker');
    assert.ok(truncation.dropped >= 10, `should report dropped count, got ${truncation.dropped}`);
  });

  it('preserves meta-observations when capping, with meta first', () => {
    // Target has pagination, and >50 out-of-scope refs — meta observation
    // must survive the cap AND sit at the front so a positional cap never
    // drops the grader-signal primitives in favor of redundant entries.
    const manyRefs = [];
    for (let i = 0; i < 60; i++) {
      manyRefs.push({ agent_url: `https://other-${i}.example.com`, id: `f${i}` });
    }
    const context = { products: [{ format_ids: manyRefs }] };
    const taskResult = {
      success: true,
      data: { formats: [], pagination: { has_more: true } },
    };
    const [result] = runOne(
      refsResolveCheck({
        scope: { key: 'agent_url', equals: '$agent_url' },
        on_out_of_scope: 'warn',
      }),
      taskResult,
      context
    );
    const kinds = result.observations.map(o => o.kind);
    const pagIdx = kinds.indexOf('target_paginated');
    const scopeIdx = kinds.indexOf('scope_excluded_all_refs');
    const firstRef = kinds.indexOf('out_of_scope_ref');
    assert.ok(pagIdx !== -1, 'target_paginated must be preserved');
    assert.ok(scopeIdx !== -1, 'scope_excluded_all_refs must be preserved');
    assert.ok(pagIdx < firstRef && scopeIdx < firstRef, 'meta-observations must precede per-ref observations');
  });

  // ──────────────────────────────────────────────────────────
  // Hardening: security review follow-ups
  // ──────────────────────────────────────────────────────────

  it('strips userinfo even from credential-shaped substrings in non-URL fields', () => {
    // An id containing a scheme://user:pass@host shape should have creds
    // scrubbed too — the URL parser short-circuits on strings like this
    // because the id field is not URL-keyed, so belt-and-suspenders applies.
    const context = {
      products: [{ format_ids: [{ agent_url: AGENT_URL, id: 'see https://user:token@evil.com/p for info' }] }],
    };
    const taskResult = { success: true, data: { formats: [] } };
    const [result] = runOne(refsResolveCheck(), taskResult, context);
    const missingId = result.actual.missing[0].id;
    assert.ok(!missingId.includes('user:token@'), `credentials must be scrubbed, got: ${missingId}`);
  });

  it('rejects non-http schemes in URL-keyed fields to close stored-XSS vectors', () => {
    const context = {
      products: [{ format_ids: [{ agent_url: 'javascript:alert(1)', id: 'x' }] }],
    };
    const taskResult = { success: true, data: { formats: [] } };
    const [result] = runOne(
      refsResolveCheck({ scope: { key: 'agent_url', equals: '$agent_url' }, on_out_of_scope: 'warn' }),
      taskResult,
      context
    );
    const obs = (result.observations ?? []).find(o => o.kind === 'out_of_scope_ref');
    assert.ok(obs, 'expected out_of_scope_ref observation');
    assert.ok(
      !String(obs.ref.agent_url).includes('alert'),
      `javascript: payload must be neutered, got: ${obs.ref.agent_url}`
    );
    assert.ok(String(obs.ref.agent_url).startsWith('<non-http scheme'));
  });

  it('rejects match_keys drawn from Object prototype (no prototype pollution via storyboard config)', () => {
    const context = { products: [{ format_ids: [{}] }] };
    const taskResult = { success: true, data: { formats: [{ format_id: {} }] } };
    const [result] = runOne(
      refsResolveCheck({
        match_keys: ['constructor', 'toString'],
      }),
      taskResult,
      context
    );
    // refsMatch guards via hasOwnProperty, and {} has no OWN `constructor`
    // or `toString`, so the match comparator returns false (not a vacuous
    // match). The source ref is therefore graded missing but the projected
    // report object contains no prototype-chain values.
    assert.strictEqual(result.passed, false);
    const first = result.actual.missing[0];
    // Own-property only — projectRefForReport filters with hasOwnProperty.
    assert.ok(!Object.prototype.hasOwnProperty.call(first, 'constructor'));
    assert.ok(!Object.prototype.hasOwnProperty.call(first, 'toString'));
  });

  it('truncates long strings on code-point boundaries, not surrogate halves', () => {
    // 300 emoji = 600 UTF-16 code units. Truncation that cleaves surrogate
    // pairs produces a lone surrogate that breaks JSON.stringify output.
    const longEmoji = '🎯'.repeat(300);
    const context = {
      products: [{ format_ids: [{ agent_url: AGENT_URL, id: longEmoji }] }],
    };
    const taskResult = { success: true, data: { formats: [] } };
    const [result] = runOne(refsResolveCheck(), taskResult, context);
    const missingId = result.actual.missing[0].id;
    // JSON.stringify must not produce invalid surrogate sequences.
    const roundTrip = JSON.parse(JSON.stringify(missingId));
    assert.strictEqual(typeof roundTrip, 'string');
    assert.ok(missingId.endsWith('…'), 'should still end with ellipsis');
    // No lone surrogates: every high surrogate must have a low-surrogate pair.
    for (let i = 0; i < missingId.length; i++) {
      const code = missingId.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = missingId.charCodeAt(i + 1);
        assert.ok(next >= 0xdc00 && next <= 0xdfff, `lone high surrogate at ${i}`);
        i++;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        assert.fail(`lone low surrogate at ${i}`);
      }
    }
  });
});
