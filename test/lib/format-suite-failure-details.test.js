// Tests for issue #305: formatSuiteResults should include step-level failure details

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { formatSuiteResults } = require('../../dist/lib/testing/index.js');

describe('formatSuiteResults includes step-level failure details', () => {
  test('includes failed step names and errors for failing scenarios', () => {
    const suite = {
      agent_url: 'https://example.com/mcp/',
      agent_profile: { name: 'Test Agent', tools: ['get_products'] },
      scenarios_run: ['validation'],
      scenarios_skipped: [],
      results: [
        {
          scenario: 'validation',
          overall_passed: false,
          summary: '1 passed, 2 failed out of 3 step(s)',
          total_duration_ms: 2513,
          steps: [
            { step: 'Valid media buy', task: 'create_media_buy', passed: true, duration_ms: 800 },
            {
              step: 'Negative budget rejection',
              task: 'create_media_buy',
              passed: false,
              duration_ms: 412,
              error: 'CRITICAL: Agent accepted negative budget - must validate minimum: 0',
            },
            {
              step: 'Missing required fields',
              task: 'create_media_buy',
              passed: false,
              duration_ms: 301,
              error: 'Agent accepted request without required product_id',
            },
          ],
        },
      ],
      overall_passed: false,
      passed_count: 0,
      failed_count: 1,
      total_duration_ms: 2513,
      tested_at: '2025-01-01T00:00:00.000Z',

    };

    const output = formatSuiteResults(suite);

    // Should include the failed step names
    assert.ok(output.includes('Negative budget rejection'), 'should include failed step name');
    assert.ok(output.includes('Missing required fields'), 'should include second failed step name');

    // Should include the error messages
    assert.ok(output.includes('Agent accepted negative budget'), 'should include error detail for budget step');
    assert.ok(
      output.includes('Agent accepted request without required product_id'),
      'should include error detail for missing fields step'
    );

    // Should include task names
    assert.ok(output.includes('`create_media_buy`'), 'should include task name');

    // Should NOT include passing steps in the failure details
    assert.ok(!output.includes('Valid media buy'), 'should not include passing step details');
  });

  test('does not include step details for passing scenarios', () => {
    const suite = {
      agent_url: 'https://example.com/mcp/',
      agent_profile: { name: 'Test Agent', tools: ['get_products'] },
      scenarios_run: ['discovery'],
      scenarios_skipped: [],
      results: [
        {
          scenario: 'discovery',
          overall_passed: true,
          summary: '2 passed',
          total_duration_ms: 500,
          steps: [
            { step: 'Get products', task: 'get_products', passed: true, duration_ms: 200 },
            { step: 'List formats', task: 'list_creative_formats', passed: true, duration_ms: 300 },
          ],
        },
      ],
      overall_passed: true,
      passed_count: 1,
      failed_count: 0,
      total_duration_ms: 500,
      tested_at: '2025-01-01T00:00:00.000Z',

    };

    const output = formatSuiteResults(suite);

    // Should not have step-level indentation for passing scenarios
    assert.ok(!output.includes('   ❌'), 'passing scenario should not show step details');
    assert.ok(!output.includes('   ✅'), 'passing scenario should not show step details');
  });

  test('handles steps without task name', () => {
    const suite = {
      agent_url: 'https://example.com/mcp/',
      agent_profile: { name: 'Test Agent', tools: [] },
      scenarios_run: ['health_check'],
      scenarios_skipped: [],
      results: [
        {
          scenario: 'health_check',
          overall_passed: false,
          summary: '0 passed, 1 failed',
          total_duration_ms: 100,
          steps: [{ step: 'Agent responds', passed: false, duration_ms: 100, error: 'Connection refused' }],
        },
      ],
      overall_passed: false,
      passed_count: 0,
      failed_count: 1,
      total_duration_ms: 100,
      tested_at: '2025-01-01T00:00:00.000Z',

    };

    const output = formatSuiteResults(suite);
    assert.ok(output.includes('Agent responds'), 'should show step name');
    assert.ok(output.includes('Connection refused'), 'should show error');
  });
});
