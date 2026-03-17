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

import type { BuildCreativeRequest, PreviewCreativeRequest } from '../../types/tools.generated';
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
      const formatDisplayName = format.name || format.format_id.id;
      const { result, step } = await runStep<TaskResult>(
        `Build creative: ${formatDisplayName}`,
        'build_creative',
        async () =>
          client.buildCreative({
            target_format_id: format.format_id,
            brand: resolveBrand(options),
            message: `Create a ${format.type || 'display'} ad for an e-commerce brand promoting summer sale`,
            quality: 'draft',
            include_preview: true,
          } as unknown as BuildCreativeRequest) as Promise<TaskResult>
      );

      if (result?.success && result?.data) {
        const data = result.data as {
          creative_manifest?: { format_id?: unknown; assets?: Record<string, unknown> };
          creative_manifests?: Array<{ format_id?: unknown; assets?: Record<string, unknown> }>;
          preview?: { previews?: unknown[] };
        };
        const manifest = data.creative_manifest || data.creative_manifests?.[0];
        step.details = `Built creative manifest for format ${formatDisplayName}`;
        step.response_preview = JSON.stringify(
          {
            format_id: manifest?.format_id || format.format_id,
            asset_keys: Object.keys(manifest?.assets || {}),
            has_preview: !!data.preview,
            preview_count: data.preview?.previews?.length || 0,
          },
          null,
          2
        );
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
        client.previewCreative({
          request_type: 'single',
          creative_manifest: {
            format_id: formatsToTest[0]?.format_id || {
              agent_url: 'https://creative.adcontextprotocol.org',
              id: 'display_300x250',
            },
            name: 'Minimal Test Creative',
            assets: {},
          },
        } as unknown as PreviewCreativeRequest) as Promise<TaskResult>
    );
    steps.push(minimalStep);

    // Test 2: Preview with sample assets
    const sampleFormat = formatsToTest[0];
    if (sampleFormat) {
      const { result, step } = await runStep<TaskResult>(
        `Preview creative: with assets (${sampleFormat.format_id.id})`,
        'preview_creative',
        async () =>
          client.previewCreative({
            request_type: 'single',
            creative_manifest: {
              format_id: sampleFormat.format_id,
              name: 'Full Test Creative',
              assets: buildTestAssets(sampleFormat) as unknown as Record<string, unknown>,
            },
          } as unknown as PreviewCreativeRequest) as Promise<TaskResult>
      );

      if (result?.success && result?.data) {
        const data = result.data as {
          previews?: Array<{ renders?: unknown[] }>;
          interactive_url?: string;
        };
        const previews = data.previews || [];
        const renderCount = previews.reduce((count, preview) => count + (preview.renders?.length || 0), 0);
        step.details = `Generated preview with ${previews.length} variant(s)`;
        step.response_preview = JSON.stringify(
          {
            has_renders: renderCount > 0,
            preview_count: previews.length,
            render_count: renderCount,
            interactive_url: data.interactive_url,
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
        client.previewCreative({
          request_type: 'single',
          creative_manifest: {
            format_id: { agent_url: 'https://creative.adcontextprotocol.org', id: 'INVALID_FORMAT_ID_12345' },
            name: 'Error Test Creative',
            assets: {},
          },
        } as unknown as PreviewCreativeRequest) as Promise<TaskResult>
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
 * Test: Creative Lifecycle
 *
 * Chains creative protocol operations end-to-end:
 * 1. list_creative_formats → verify format schema
 * 2. sync_creatives with multiple creatives → verify per-creative status
 * 3. list_creatives (no snapshot) → verify basic fields
 * 4. list_creatives (include_snapshot: true) → verify snapshot or snapshot_unavailable_reason
 * 5. build_creative or preview_creative on synced creative → adapt to agent capabilities
 */
export async function testCreativeLifecycle(
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

  // Check if agent has list_creative_formats tool
  if (!profile.tools.includes('list_creative_formats')) {
    steps.push({
      step: 'Check for list_creative_formats',
      passed: false,
      error: 'Agent does not support list_creative_formats',
      duration_ms: 0,
    });
    return { steps, profile };
  }

  // Step 1: List creative formats
  const { result: formatList, step: formatStep } = await runStep<any>(
    'List creative formats',
    'list_creative_formats',
    async () => client.executeTask('list_creative_formats', {})
  );

  if (!formatStep.passed || !formatList?.formats) {
    formatStep.passed = false;
    formatStep.error = 'Failed to list creative formats';
    steps.push(formatStep);
    return { steps, profile };
  }

  const formats = formatList.formats;
  if (!Array.isArray(formats) || formats.length === 0) {
    formatStep.passed = false;
    formatStep.error = 'No formats returned';
    steps.push(formatStep);
    return { steps, profile };
  }

  const firstFormat = formats[0];
  if (!firstFormat.format_id || !firstFormat.type) {
    formatStep.passed = false;
    formatStep.error = 'Format missing format_id or type field';
    steps.push(formatStep);
    return { steps, profile };
  }

  formatStep.passed = true;
  formatStep.details = `Found ${formats.length} formats, first: ${firstFormat.format_id}`;
  steps.push(formatStep);

  // Step 2: Sync multiple creatives
  if (!profile.tools.includes('sync_creatives')) {
    steps.push({
      step: 'Check for sync_creatives',
      passed: false,
      error: 'Agent does not support sync_creatives',
      duration_ms: 0,
    });
    return { steps, profile };
  }

  const testCreatives = [
    {
      platform_id: 'test-image-' + Date.now(),
      format_id: formats[0].format_id,
      concept: 'Test image creative',
    },
    {
      platform_id: 'test-video-' + Date.now(),
      format_id: formats[0].format_id,
      concept: 'Test video creative',
    },
  ];

  const { result: syncResult, step: syncStep } = await runStep<any>(
    'Sync creatives (2 items)',
    'sync_creatives',
    async () => client.executeTask('sync_creatives', { creatives: testCreatives })
  );

  if (!syncStep.passed || !syncResult?.creatives) {
    syncStep.passed = false;
    syncStep.error = 'Failed to sync creatives';
    steps.push(syncStep);
    return { steps, profile };
  }

  if (!Array.isArray(syncResult.creatives)) {
    syncStep.passed = false;
    syncStep.error = 'sync_creatives response missing creatives array';
    steps.push(syncStep);
    return { steps, profile };
  }

  syncStep.passed = true;
  syncStep.details = `Synced ${syncResult.creatives.length} creatives`;
  steps.push(syncStep);

  // Step 3: List creatives without snapshot
  if (!profile.tools.includes('list_creatives')) {
    steps.push({
      step: 'Check for list_creatives',
      passed: false,
      error: 'Agent does not support list_creatives',
      duration_ms: 0,
    });
    return { steps, profile };
  }

  const { result: listResult, step: listStep } = await runStep<any>(
    'List creatives (no snapshot)',
    'list_creatives',
    async () => client.executeTask('list_creatives', { include_snapshot: false })
  );

  if (!listStep.passed || !listResult?.creatives) {
    listStep.passed = false;
    listStep.error = 'Failed to list creatives';
    steps.push(listStep);
    return { steps, profile };
  }

  if (!Array.isArray(listResult.creatives)) {
    listStep.passed = false;
    listStep.error = 'list_creatives response missing creatives array';
    steps.push(listStep);
    return { steps, profile };
  }

  if (listResult.creatives.length > 0) {
    const firstCreative = listResult.creatives[0];
    if (!firstCreative.creative_id) {
      listStep.passed = false;
      listStep.error = 'Creative missing creative_id field';
      steps.push(listStep);
      return { steps, profile };
    }
    if ('snapshot' in firstCreative) {
      listStep.passed = false;
      listStep.error = 'Snapshot field present when include_snapshot: false';
      steps.push(listStep);
      return { steps, profile };
    }
  }

  listStep.passed = true;
  listStep.details = `Listed ${listResult.creatives.length} creatives (no snapshot)`;
  steps.push(listStep);

  // Step 4: List creatives with snapshot
  const { result: listSnapshotResult, step: listSnapshotStep } = await runStep<any>(
    'List creatives (with snapshot)',
    'list_creatives',
    async () => client.executeTask('list_creatives', { include_snapshot: true })
  );

  if (!listSnapshotStep.passed || !listSnapshotResult?.creatives) {
    listSnapshotStep.passed = false;
    listSnapshotStep.error = 'Failed to list creatives with snapshot';
    steps.push(listSnapshotStep);
    return { steps, profile };
  }

  let snapshotFieldsValidated = false;
  if (listSnapshotResult.creatives.length > 0) {
    const firstCreative = listSnapshotResult.creatives[0];

    if ('snapshot' in firstCreative) {
      const snapshot = firstCreative.snapshot;
      if (snapshot && typeof snapshot === 'object') {
        if ('as_of' in snapshot || 'staleness_seconds' in snapshot || 'impressions' in snapshot || 'last_served' in snapshot) {
          snapshotFieldsValidated = true;
        }
      }
    } else if ('snapshot_unavailable_reason' in firstCreative) {
      const reason = firstCreative.snapshot_unavailable_reason;
      if (['SNAPSHOT_UNSUPPORTED', 'SNAPSHOT_TEMPORARILY_UNAVAILABLE', 'SNAPSHOT_PERMISSION_DENIED'].includes(reason)) {
        snapshotFieldsValidated = true;
      }
    }
  }

  listSnapshotStep.passed = snapshotFieldsValidated || listSnapshotResult.creatives.length === 0;
  listSnapshotStep.details = snapshotFieldsValidated
    ? 'Snapshot field or unavailable_reason validated'
    : 'No creatives to validate snapshot field';
  steps.push(listSnapshotStep);

  // Step 5: Build creative (generative or tag-serving mode)
  if (!profile.tools.includes('build_creative')) {
    steps.push({
      step: 'Check for build_creative',
      passed: false,
      error: 'Agent does not support build_creative',
      duration_ms: 0,
    });
    return { steps, profile };
  }

  const buildParams: any = {
    format_id: formats[0].format_id,
    brand_manifest: { name: 'Test Brand', description: 'Test brand for creative generation' },
    prompt: 'Create a professional ad creative',
  };

  const { result: buildResult, step: buildStep } = await runStep<any>(
    'Build creative (generative mode)',
    'build_creative',
    async () => client.executeTask('build_creative', buildParams)
  );

  if (buildStep.passed && buildResult) {
    if (buildResult.creative) {
      buildStep.passed = true;
      buildStep.details = 'Generative build_creative succeeded';
      steps.push(buildStep);
    } else {
      buildStep.passed = false;
      buildStep.error = 'build_creative response missing creative field';
      steps.push(buildStep);
    }
  } else {
    if (syncResult?.creatives && syncResult.creatives.length > 0) {
      const syncedCreativeId = syncResult.creatives[0].creative_id || syncResult.creatives[0].platform_id;

      const tagParams: any = { creative_id: syncedCreativeId };
      const { result: tagResult, step: tagStep } = await runStep<any>(
        'Build creative (tag-serving mode)',
        'build_creative',
        async () => client.executeTask('build_creative', tagParams)
      );

      if (tagStep.passed && tagResult?.creative) {
        tagStep.passed = true;
        tagStep.details = 'Tag-serving build_creative succeeded';
        steps.push(tagStep);
      } else {
        tagStep.passed = false;
        tagStep.error = 'Both generative and tag-serving modes failed';
        steps.push(tagStep);
      }
    } else {
      buildStep.passed = false;
      buildStep.error = 'Cannot test tag-serving mode without synced creative';
      steps.push(buildStep);
    }
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
    return formats.filter(f => options.format_ids!.includes(f.format_id.id));
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
