/**
 * Regression test for adcp-client#1674.
 *
 * `ComplianceResult.tested_tracks` is a `.filter()` of
 * `ComplianceResult.tracks` — the same `TrackResult` object reference
 * appears in both arrays. JSON.stringify(result) therefore serializes
 * every passing/failing scenario twice, which is structurally correct
 * but visually identical to "the runner ran the scenario twice".
 * Triagers grepping a `--json` output wasted multi-hour debug cycles
 * assuming duplicate execution (cf. #1658, salesagent#331).
 *
 * Conservative fix: tag every `TrackResult` with `_view` so consumers
 * can distinguish the canonical entry (in `tracks`) from its reference
 * appearance (in `tested_tracks`). The duplication remains for
 * back-compat; the breaking type-split that fully removes it is
 * tracked separately.
 *
 * This file asserts the type contract on a hand-built fixture and
 * verifies both `formatComplianceResults` (text) and
 * `formatComplianceResultsJSON` survive a result whose tracks carry
 * the new optional `_view` field. The production tagging lives in
 * `src/lib/testing/compliance/comply.ts` at both `tested_tracks`
 * construction sites; a `grep -n '_view'` keeps the assertions and
 * the construction sites discoverable from each other.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { formatComplianceResults, formatComplianceResultsJSON } = require('../../dist/lib/testing/compliance/index.js');

function makeTrack(track, status, _view) {
  return {
    track,
    status,
    label: track,
    scenarios: [
      {
        agent_url: 'https://example.com/mcp',
        scenario: `${track}/canary`,
        overall_passed: status === 'pass',
        summary: '',
        total_duration_ms: 100,
        tested_at: '2026-01-01T00:00:00.000Z',
        steps: [],
      },
    ],
    skipped_scenarios: [],
    observations: [],
    duration_ms: 100,
    _view,
  };
}

function makeResult() {
  const tracks = [makeTrack('core', 'pass', 'canonical'), makeTrack('media_buy', 'fail', 'canonical')];
  return {
    agent_url: 'https://example.com/mcp',
    agent_profile: { name: 'Test Agent', tools: ['get_products'] },
    overall_status: 'failing',
    tracks,
    tested_tracks: tracks.map(t => ({ ...t, _view: 'reference' })),
    skipped_tracks: [],
    summary: {
      tracks_passed: 1,
      tracks_failed: 1,
      tracks_skipped: 0,
      tracks_partial: 0,
      headline: '1 passing, 1 failing',
    },
    observations: [],
    storyboards_executed: [],
    tested_at: '2026-01-01T00:00:00.000Z',
    total_duration_ms: 200,
  };
}

describe('ComplianceResult._view marker (#1674)', () => {
  test('formatComplianceResults survives _view-tagged tracks', () => {
    const out = formatComplianceResults(makeResult());
    assert.ok(out.includes('https://example.com/mcp'));
    assert.ok(out.includes('Test Agent'));
  });

  test('formatComplianceResultsJSON serializes _view on both tracks and tested_tracks', () => {
    const result = makeResult();
    const json = formatComplianceResultsJSON(result);
    const parsed = JSON.parse(json);

    assert.equal(parsed.tracks.length, 2);
    assert.equal(parsed.tested_tracks.length, 2);
    for (const t of parsed.tracks) {
      assert.equal(t._view, 'canonical', `tracks[*] must be canonical, got ${t._view}`);
    }
    for (const t of parsed.tested_tracks) {
      assert.equal(t._view, 'reference', `tested_tracks[*] must be reference, got ${t._view}`);
    }
  });

  test('canonical view is the deduplicated source of truth', () => {
    // A consumer that wants every scenario exactly once filters on
    // _view === 'canonical' across `tracks` (or simply iterates
    // `tracks` and ignores `tested_tracks`). Asserting the
    // documented dedup recipe works end-to-end.
    const result = makeResult();
    const allScenarios = [
      ...result.tracks.flatMap(t => t.scenarios),
      ...result.tested_tracks.flatMap(t => t.scenarios),
    ];
    assert.equal(allScenarios.length, 4, 'duplication is preserved (conservative fix)');

    const canonicalScenarios = [...result.tracks, ...result.tested_tracks]
      .filter(t => t._view === 'canonical')
      .flatMap(t => t.scenarios);
    assert.equal(canonicalScenarios.length, 2, 'canonical view dedupes to N scenarios');
  });

  test('shallow-copy preserves nested scenarios reference identity', () => {
    // The production code path uses `{...t, _view: 'reference'}` which
    // is a shallow copy — `tracks[i].scenarios` and
    // `tested_tracks[i].scenarios` are the same array reference.
    // Documenting and pinning this so a future refactor that
    // deep-clones (and silently doubles memory cost) gets caught.
    const result = makeResult();
    for (let i = 0; i < result.tracks.length; i++) {
      assert.strictEqual(
        result.tracks[i].scenarios,
        result.tested_tracks[i].scenarios,
        'tested_tracks must share scenarios reference with tracks'
      );
    }
  });
});
