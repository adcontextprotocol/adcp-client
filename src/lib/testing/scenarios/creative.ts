/**
 * Creative Agent Testing Scenarios
 *
 * Tests creative agent capabilities including:
 * - list_creative_formats / list_formats
 * - build_creative
 * - preview_creative
 *
 * Enhanced to:
 * - Test multiple formats from the agent's actual catalog
 * - Test with both required and optional assets
 * - Validate preview renders
 */

import type { TestOptions, TestStepResult, AgentProfile, TaskResult } from '../types';
import { createTestClient, runStep, discoverAgentProfile, discoverCreativeFormats, resolveBrand } from '../client';

/**
 * Test: Creative Flow (for creative agents)
 *
 * Flow: list_formats -> build_creative (multiple formats) -> preview_creative (with assets)
 */
export async function testCreativeFlow(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, options.protocol || 'mcp', options);

  // Discover agent profile
  const { profile, step: profileStep } = await discoverAgentProfile(client);
  steps.push(profileStep);

  if (!profileStep.passed) {
    return { steps, profile };
  }

  // Discover creative formats with full details
  const { formats, step: formatStep } = await discoverCreativeFormats(client, profile);
  steps.push(formatStep);

  if (!formatStep.passed || !formats || formats.length === 0) {
    return { steps, profile: { ...profile, supported_formats: formats || [] } };
  }

  // Store discovered formats in profile
  profile.supported_formats = formats;

  // Determine which formats to test
  const formatsToTest = selectFormatsToTest(formats || [], options);

  // Build creative for each selected format
  if (profile.tools.includes('build_creative')) {
    for (const format of formatsToTest) {
      const { result, step } = await runStep<TaskResult>(
        `Build creative: ${format.name || format.format_id}`,
        'build_creative',
        async () =>
          client.executeTask('build_creative', {
            format_id: format.format_id,
            brand: resolveBrand(options),
            prompt: `Create a ${format.type || 'display'} ad for an e-commerce brand promoting summer sale`,
          }) as Promise<TaskResult>
      );

      if (result?.success && result?.data) {
        const data = result.data as any;
        step.details = `Built creative for format ${format.format_id}`;
        step.response_preview = JSON.stringify(
          {
            creative_id: data.creative_id || data.creative?.creative_id,
            format_id: data.format_id || data.creative?.format_id,
            has_assets: !!(data.assets?.length || data.creative?.assets?.length),
          },
          null,
          2
        );
        step.created_id = data.creative_id || data.creative?.creative_id;
      } else if (result && !result.success) {
        step.passed = false;
        step.error = result.error || 'build_creative failed';
      }
      steps.push(step);
    }
  }

  // Preview creative with various asset configurations
  if (profile.tools.includes('preview_creative')) {
    // Test 1: Preview with minimal assets (empty)
    const { step: minimalStep } = await runStep<TaskResult>(
      'Preview creative: minimal assets',
      'preview_creative',
      async () =>
        client.executeTask('preview_creative', {
          creative: {
            format_id: formatsToTest[0]?.format_id || 'display_300x250',
            name: 'Minimal Test Creative',
            assets: [],
          },
        }) as Promise<TaskResult>
    );
    steps.push(minimalStep);

    // Test 2: Preview with sample assets
    const sampleFormat = formatsToTest[0];
    if (sampleFormat) {
      const { result, step } = await runStep<TaskResult>(
        `Preview creative: with assets (${sampleFormat.format_id})`,
        'preview_creative',
        async () =>
          client.executeTask('preview_creative', {
            creative: {
              format_id: sampleFormat.format_id,
              name: 'Full Test Creative',
              assets: buildTestAssets(sampleFormat),
            },
          }) as Promise<TaskResult>
      );

      if (result?.success && result?.data) {
        const data = result.data as any;
        step.details = `Generated preview with ${data.renders?.length || 0} render(s)`;
        step.response_preview = JSON.stringify(
          {
            has_renders: !!(data.renders?.length || data.preview_url),
            render_count: data.renders?.length || (data.preview_url ? 1 : 0),
            preview_url: data.preview_url,
          },
          null,
          2
        );
      } else if (result && !result.success) {
        step.passed = false;
        step.error = result.error || 'preview_creative failed';
      }
      steps.push(step);
    }

    // Test 3: Preview with invalid format_id (error case)
    const { result: errorResult, step: errorStep } = await runStep<TaskResult>(
      'Preview creative: invalid format (error expected)',
      'preview_creative',
      async () =>
        client.executeTask('preview_creative', {
          creative: {
            format_id: 'INVALID_FORMAT_ID_12345',
            name: 'Error Test Creative',
            assets: [],
          },
        }) as Promise<TaskResult>
    );

    // This should fail - if it succeeds with invalid format, that's a bug
    if (errorResult?.success) {
      errorStep.passed = false;
      errorStep.error = 'Expected error for invalid format_id but got success';
    } else {
      errorStep.passed = true;
      errorStep.details = 'Correctly rejected invalid format_id';
    }
    steps.push(errorStep);
  }

  return { steps, profile };
}

/**
 * Select which formats to test based on options
 */
function selectFormatsToTest(
  formats: NonNullable<AgentProfile['supported_formats']>,
  options: TestOptions
): NonNullable<AgentProfile['supported_formats']> {
  // If specific format_ids provided, use those
  if (options.format_ids?.length) {
    return formats.filter(f => options.format_ids!.includes(f.format_id));
  }

  // If test_all_formats, test up to max_formats_to_test
  if (options.test_all_formats) {
    const maxFormats = options.max_formats_to_test || 5;
    return formats.slice(0, maxFormats);
  }

  // Default: test one format of each type (display, video, audio, native, dooh)
  const byType = new Map<string, NonNullable<AgentProfile['supported_formats']>[0]>();
  for (const format of formats) {
    const type = format.type || 'unknown';
    if (!byType.has(type)) {
      byType.set(type, format);
    }
  }

  // Return at least one format, max 3 different types
  const selected = Array.from(byType.values()).slice(0, 3);
  return selected.length > 0 ? selected : formats.slice(0, 1);
}

/**
 * Build test assets for a format based on its requirements
 */
function buildTestAssets(
  format: NonNullable<AgentProfile['supported_formats']>[0]
): Array<{ asset_id: string; asset_type: string; url: string }> {
  const assets: Array<{ asset_id: string; asset_type: string; url: string }> = [];

  // Add required assets
  if (format.required_assets?.length) {
    for (const assetName of format.required_assets) {
      assets.push({
        asset_id: assetName,
        asset_type: guessAssetType(assetName),
        url: getTestAssetUrl(assetName),
      });
    }
  }

  // If no required assets, add a default image
  if (assets.length === 0) {
    assets.push({
      asset_id: 'primary_image',
      asset_type: 'image',
      url: 'https://via.placeholder.com/300x250.png?text=Test+Creative',
    });
  }

  return assets;
}

/**
 * Guess asset type from asset name
 */
function guessAssetType(assetName: string): string {
  const lower = assetName.toLowerCase();
  if (lower.includes('video') || lower.includes('clip')) return 'video';
  if (lower.includes('audio') || lower.includes('sound')) return 'audio';
  if (lower.includes('logo')) return 'image';
  if (lower.includes('text') || lower.includes('headline') || lower.includes('copy')) return 'text';
  return 'image';
}

/**
 * Get a test asset URL for testing
 */
function getTestAssetUrl(assetName: string): string {
  const type = guessAssetType(assetName);
  switch (type) {
    case 'video':
      return 'https://storage.googleapis.com/webfundamentals-assets/videos/chrome.mp4';
    case 'audio':
      return 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3';
    default:
      return 'https://via.placeholder.com/300x250.png?text=Test+Asset';
  }
}

