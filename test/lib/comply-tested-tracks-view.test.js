/**
 * Regression test for adcp-client#1791 (follow-up to #1674).
 *
 * `tested_tracks` is now a reference-only projection. Scenario arrays live
 * exclusively on canonical `tracks`, so JSON output contains one serialized
 * copy of every scenario while status-oriented consumers retain the filtered
 * track list.
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
    // Deliberately use the pre-v13 runtime shape here. The JSON formatter must
    // normalize legacy JavaScript inputs as well as newly constructed results.
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

describe('ComplianceResult tested_tracks projection (#1791)', () => {
  test('formatComplianceResults survives _view-tagged tracks', () => {
    const out = formatComplianceResults(makeResult());
    assert.ok(out.includes('https://example.com/mcp'));
    assert.ok(out.includes('Test Agent'));
  });

  test('formatComplianceResultsJSON emits reference-only tested_tracks entries', () => {
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
      assert.equal('scenarios' in t, false, 'tested_tracks[*] must omit scenarios');
      assert.equal('skipped_scenarios' in t, false, 'tested_tracks[*] must omit skipped_scenarios');
    }
  });

  test('JSON serializes every scenario exactly once', () => {
    const result = makeResult();
    const parsed = JSON.parse(formatComplianceResultsJSON(result));
    const scenarioCount = parsed.tracks.reduce((count, track) => count + track.scenarios.length, 0);
    const serializedScenarioKeys = (formatComplianceResultsJSON(result).match(/"scenario":/g) ?? []).length;
    assert.equal(serializedScenarioKeys, scenarioCount);
  });
});
