/**
 * Unit tests for the comply/convince compliance assessment module
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  // Comply
  comply,
  formatComplianceResults,
  formatComplianceResultsJSON,
  // Convince
  formatConvinceResults,
  formatConvinceResultsJSON,
  // Brief library
  SAMPLE_BRIEFS,
  getBriefById,
  getBriefsByVertical,
} = require('../../dist/lib/testing/compliance/index.js');

// ============================================================
// Sample Brief Library
// ============================================================

describe('SAMPLE_BRIEFS', () => {
  test('contains at least 5 briefs', () => {
    assert.ok(SAMPLE_BRIEFS.length >= 5, `Expected 5+ briefs, got ${SAMPLE_BRIEFS.length}`);
  });

  test('every brief has required fields', () => {
    for (const brief of SAMPLE_BRIEFS) {
      assert.ok(brief.id, `Brief missing id`);
      assert.ok(brief.name, `Brief ${brief.id} missing name`);
      assert.ok(brief.vertical, `Brief ${brief.id} missing vertical`);
      assert.ok(brief.brief, `Brief ${brief.id} missing brief text`);
      assert.ok(brief.evaluation_hints, `Brief ${brief.id} missing evaluation_hints`);
    }
  });

  test('brief IDs are unique', () => {
    const ids = SAMPLE_BRIEFS.map(b => b.id);
    const unique = new Set(ids);
    assert.strictEqual(ids.length, unique.size, 'Brief IDs must be unique');
  });

  test('covers multiple verticals', () => {
    const verticals = new Set(SAMPLE_BRIEFS.map(b => b.vertical));
    assert.ok(verticals.size >= 4, `Expected 4+ verticals, got ${verticals.size}`);
  });

  test('includes briefs with expected_channels', () => {
    const withChannels = SAMPLE_BRIEFS.filter(b => b.expected_channels?.length);
    assert.ok(withChannels.length >= 3, 'At least 3 briefs should specify expected_channels');
  });

  test('includes briefs with budget_context', () => {
    const withBudget = SAMPLE_BRIEFS.filter(b => b.budget_context);
    assert.ok(withBudget.length >= 5, 'At least 5 briefs should specify budget_context');
  });
});

describe('getBriefById', () => {
  test('returns a brief by ID', () => {
    const brief = getBriefById('luxury_auto_ev');
    assert.ok(brief, 'Should find luxury_auto_ev');
    assert.strictEqual(brief.name, 'Luxury Auto EV Launch');
  });

  test('returns undefined for unknown ID', () => {
    assert.strictEqual(getBriefById('nonexistent'), undefined);
  });
});

describe('getBriefsByVertical', () => {
  test('returns briefs matching vertical (case insensitive)', () => {
    const results = getBriefsByVertical('auto');
    assert.ok(results.length >= 1, 'Should find at least 1 automotive brief');
  });

  test('returns empty for unknown vertical', () => {
    const results = getBriefsByVertical('zzzunknownzzz');
    assert.strictEqual(results.length, 0);
  });
});

// ============================================================
// Compliance Result Formatting
// ============================================================

describe('formatComplianceResults', () => {
  const mockResult = {
    agent_url: 'https://example.com/mcp',
    agent_profile: { name: 'Test Agent', tools: ['get_products', 'create_media_buy'] },
    tracks: [
      {
        track: 'core',
        status: 'pass',
        label: 'Core Protocol',
        scenarios: [
          { scenario: 'health_check', overall_passed: true, steps: [], summary: 'Passed', total_duration_ms: 100, dry_run: true },
        ],
        skipped_scenarios: [],
        observations: [],
        duration_ms: 100,
      },
      {
        track: 'products',
        status: 'fail',
        label: 'Product Discovery',
        scenarios: [
          {
            scenario: 'pricing_edge_cases',
            overall_passed: false,
            steps: [
              { step: 'Check pricing', passed: false, duration_ms: 50, error: 'No pricing options' },
            ],
            summary: 'Failed',
            total_duration_ms: 50,
            dry_run: true,
          },
        ],
        skipped_scenarios: [],
        observations: [],
        duration_ms: 50,
      },
      {
        track: 'signals',
        status: 'skip',
        label: 'Signals',
        scenarios: [],
        skipped_scenarios: ['signals_flow'],
        observations: [],
        duration_ms: 0,
      },
    ],
    summary: {
      tracks_passed: 1,
      tracks_failed: 1,
      tracks_skipped: 1,
      tracks_partial: 0,
      headline: '1 passing, 1 failing',
    },
    observations: [
      { category: 'completeness', severity: 'warning', message: 'Missing fields' },
    ],
    tested_at: new Date().toISOString(),
    total_duration_ms: 150,
    dry_run: true,
  };

  test('includes agent name and URL', () => {
    const output = formatComplianceResults(mockResult);
    assert.ok(output.includes('https://example.com/mcp'), 'Should include agent URL');
    assert.ok(output.includes('Test Agent'), 'Should include agent name');
  });

  test('shows track statuses', () => {
    const output = formatComplianceResults(mockResult);
    assert.ok(output.includes('Core Protocol'), 'Should include core track');
    assert.ok(output.includes('Product Discovery'), 'Should include products track');
    assert.ok(output.includes('not applicable'), 'Should show skipped tracks');
  });

  test('shows failed step details', () => {
    const output = formatComplianceResults(mockResult);
    assert.ok(output.includes('No pricing options'), 'Should show error details');
  });

  test('shows advisory observations', () => {
    const output = formatComplianceResults(mockResult);
    assert.ok(output.includes('Missing fields'), 'Should show observations');
  });

  test('shows summary headline', () => {
    const output = formatComplianceResults(mockResult);
    assert.ok(output.includes('1 passing, 1 failing'), 'Should show headline');
  });
});

describe('formatComplianceResultsJSON', () => {
  test('returns valid JSON', () => {
    const mockResult = {
      agent_url: 'https://example.com',
      tracks: [],
      summary: { headline: 'test' },
      observations: [],
    };
    const json = formatComplianceResultsJSON(mockResult);
    const parsed = JSON.parse(json);
    assert.strictEqual(parsed.agent_url, 'https://example.com');
  });
});

// ============================================================
// Convince Result Formatting
// ============================================================

describe('formatConvinceResults', () => {
  const mockResult = {
    agent_url: 'https://example.com/mcp',
    agent_profile: { name: 'Test Agent', tools: ['get_products'] },
    assessments: [
      {
        brief: { id: 'test', name: 'Test Brief', vertical: 'General', budget_context: '$10K' },
        products_returned: 3,
        dimensions: [
          { dimension: 'relevance', rating: 'strong', observation: 'Good match' },
          { dimension: 'pricing', rating: 'weak', observation: 'No CPC options' },
        ],
        summary: 'Mixed results',
        top_actions: ['Add CPC pricing', 'Improve descriptions'],
      },
    ],
    patterns: [
      { pattern: 'pricing is consistently weak', frequency: 'Weak in 1 of 1', impact: 'Price matters' },
    ],
    overall_summary: 'Needs pricing work',
    tested_at: new Date().toISOString(),
    total_duration_ms: 5000,
    evaluator: 'anthropic',
    dry_run: true,
  };

  test('includes brief names', () => {
    const output = formatConvinceResults(mockResult);
    assert.ok(output.includes('Test Brief'), 'Should include brief name');
  });

  test('shows dimension ratings with colored indicators', () => {
    const output = formatConvinceResults(mockResult);
    assert.ok(output.includes('relevance'), 'Should show relevance dimension');
    assert.ok(output.includes('pricing'), 'Should show pricing dimension');
  });

  test('shows action items', () => {
    const output = formatConvinceResults(mockResult);
    assert.ok(output.includes('Add CPC pricing'), 'Should show actions');
  });

  test('shows cross-brief patterns', () => {
    const output = formatConvinceResults(mockResult);
    assert.ok(output.includes('Cross-Brief Patterns'), 'Should show patterns section');
    assert.ok(output.includes('pricing is consistently weak'), 'Should show pattern');
  });

  test('shows evaluator info', () => {
    const output = formatConvinceResults(mockResult);
    assert.ok(output.includes('anthropic'), 'Should show evaluator');
  });
});

describe('formatConvinceResultsJSON', () => {
  test('returns valid JSON', () => {
    const mockResult = {
      agent_url: 'https://example.com',
      assessments: [],
      patterns: [],
      overall_summary: 'test',
    };
    const json = formatConvinceResultsJSON(mockResult);
    const parsed = JSON.parse(json);
    assert.strictEqual(parsed.agent_url, 'https://example.com');
  });
});
