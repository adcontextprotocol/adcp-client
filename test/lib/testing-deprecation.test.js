// Unit tests for testing framework deprecation warnings
const { test, describe, mock } = require('node:test');
const assert = require('node:assert');

describe('Testing Framework Deprecation Warnings', () => {
  test('should add warning when format uses assets_required', async () => {
    // Mock the ADCPMultiAgentClient
    const mockClient = {
      agent: () => ({
        getAgentInfo: async () => ({
          name: 'Test Agent',
          tools: [{ name: 'list_creative_formats' }],
        }),
        executeTask: async taskName => {
          if (taskName === 'list_creative_formats') {
            return {
              success: true,
              data: {
                formats: [
                  {
                    format_id: 'deprecated_format',
                    name: 'Deprecated Format',
                    type: 'display',
                    // Using deprecated assets_required field
                    assets_required: [{ item_type: 'individual', asset_id: 'image', asset_type: 'image' }],
                  },
                ],
              },
            };
          }
          return { success: false, error: 'Unknown task' };
        },
      }),
    };

    // Import utilities we can test directly
    const { usesDeprecatedAssetsField, getFormatAssets } = require('../../dist/lib/utils/format-assets.js');

    // Test the deprecation detection logic
    const deprecatedFormat = {
      format_id: 'deprecated_format',
      name: 'Deprecated Format',
      type: 'display',
      assets_required: [{ item_type: 'individual', asset_id: 'image', asset_type: 'image' }],
    };

    const v26Format = {
      format_id: 'v26_format',
      name: 'V2.6 Format',
      type: 'display',
      assets: [{ item_type: 'individual', asset_id: 'image', asset_type: 'image', required: true }],
    };

    // Verify deprecation detection
    assert.strictEqual(usesDeprecatedAssetsField(deprecatedFormat), true, 'Should detect deprecated format');
    assert.strictEqual(usesDeprecatedAssetsField(v26Format), false, 'Should not flag v2.6 format');

    // Verify getFormatAssets normalizes deprecated format
    const normalizedAssets = getFormatAssets(deprecatedFormat);
    assert.strictEqual(normalizedAssets.length, 1, 'Should have one asset');
    assert.strictEqual(normalizedAssets[0].required, true, 'Normalized asset should have required=true');
  });

  test('should not add warning when format uses v2.6 assets field', async () => {
    const { usesDeprecatedAssetsField } = require('../../dist/lib/utils/format-assets.js');

    const v26Format = {
      format_id: 'modern_format',
      name: 'Modern Format',
      type: 'display',
      assets: [
        { item_type: 'individual', asset_id: 'required_image', asset_type: 'image', required: true },
        { item_type: 'individual', asset_id: 'optional_image', asset_type: 'image', required: false },
      ],
    };

    assert.strictEqual(usesDeprecatedAssetsField(v26Format), false, 'Should not flag v2.6 format');
  });

  test('should count deprecation warnings in summary', () => {
    const { formatTestResultsSummary } = require('../../dist/lib/testing/formatter.js');

    const resultWithWarnings = {
      agent_url: 'https://test.agent/',
      scenario: 'creative_flow',
      overall_passed: true,
      total_duration_ms: 1000,
      dry_run: true,
      steps: [
        { step: 'Step 1', passed: true, duration_ms: 100 },
        {
          step: 'Discover formats',
          passed: true,
          duration_ms: 200,
          warnings: ['⚠️ DEPRECATION: 2 format(s) use deprecated assets_required field'],
        },
        { step: 'Step 3', passed: true, duration_ms: 100 },
      ],
    };

    const summary = formatTestResultsSummary(resultWithWarnings);
    assert.ok(summary.includes('⚠️'), 'Summary should include warning indicator');
    assert.ok(summary.includes('warning'), 'Summary should mention warnings');
  });

  test('should include warnings in formatted output', () => {
    const { formatTestResults } = require('../../dist/lib/testing/formatter.js');

    const resultWithWarnings = {
      agent_url: 'https://test.agent/',
      scenario: 'creative_flow',
      overall_passed: true,
      total_duration_ms: 1000,
      dry_run: true,
      summary: '3/3 passed',
      steps: [
        {
          step: 'Discover formats',
          task: 'list_creative_formats',
          passed: true,
          duration_ms: 200,
          details: 'Found 2 format(s)',
          warnings: [
            "⚠️ DEPRECATION: 2 format(s) use 'assets_required' field which is deprecated and will be removed in a future version.",
          ],
        },
      ],
    };

    const output = formatTestResults(resultWithWarnings);
    assert.ok(output.includes('DEPRECATION'), 'Output should include deprecation warning');
    assert.ok(output.includes('assets_required'), 'Output should mention assets_required');
  });
});
