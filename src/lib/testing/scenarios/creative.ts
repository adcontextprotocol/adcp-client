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
            format_id: formatsToTest[0]?.format_id || { agent_url: 'https://creative.adcontextprotocol.org', id: 'display_300x250' },
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

  // Step 1: Discover creative formats
  const { formats, step: formatStep } = await discoverCreativeFormats(client, profile);
  steps.push(formatStep);

  if (!formatStep.passed || !formats || formats.length === 0) {
    return { steps, profile };
  }

  profile.supported_formats = formats;

  // Validate format schema: each format should have format_id, type, and required_assets
  const formatSchemaIssues: string[] = [];
  for (const format of formats) {
    if (!format.format_id) formatSchemaIssues.push('Missing format_id');
    if (!format.type) formatSchemaIssues.push(`Format ${format.format_id}: missing type`);
  }

  steps.push({
    step: 'Validate format schema',
    passed: formatSchemaIssues.length === 0,
    duration_ms: 0,
    details:
      formatSchemaIssues.length === 0
        ? `All ${formats.length} format(s) have required fields`
        : formatSchemaIssues.join('; '),
    warnings: formatSchemaIssues.length > 0 ? formatSchemaIssues : undefined,
  });

  // Step 2: Sync multiple creatives (image + video if formats allow)
  if (profile.tools.includes('sync_creatives')) {
    const imageFormat = formats.find(f => f.type === 'display' || f.type === 'image') || formats[0];
    const videoFormat = formats.find(f => f.type === 'video');

    const creativesToSync = [
      {
        creative_id: `lifecycle-img-${Date.now()}`,
        name: 'Lifecycle Test Image Creative',
        format_id: imageFormat.format_id,
        assets: {
          primary: {
            url: 'https://via.placeholder.com/300x250.png?text=Lifecycle+Image',
            width: 300,
            height: 250,
            format: 'png',
          },
        },
      },
    ];

    if (videoFormat) {
      creativesToSync.push({
        creative_id: `lifecycle-vid-${Date.now()}`,
        name: 'Lifecycle Test Video Creative',
        format_id: videoFormat.format_id,
        assets: {
          primary: {
            url: 'https://storage.googleapis.com/webfundamentals-assets/videos/chrome.mp4',
            width: 1920,
            height: 1080,
            format: 'mp4',
          },
        },
      });
    }

    const { result: syncResult, step: syncStep } = await runStep<TaskResult>(
      `Sync ${creativesToSync.length} creative(s) to library`,
      'sync_creatives',
      async () =>
        client.executeTask('sync_creatives', {
          creatives: creativesToSync,
        }) as Promise<TaskResult>
    );

    if (syncResult?.success && syncResult?.data) {
      const data = syncResult.data as any;
      const creatives = data.creatives || [];
      const actions = creatives.map((c: any) => c.action);
      const failed = creatives.filter((c: any) => c.action === 'failed');

      syncStep.details = `Synced ${creatives.length} creative(s), actions: ${actions.join(', ')}`;
      syncStep.response_preview = JSON.stringify(
        {
          synced_count: creatives.length,
          actions,
          creative_ids: creatives.map((c: any) => c.creative_id),
          failed_count: failed.length,
          failed_errors: failed.map((c: any) => ({ creative_id: c.creative_id, errors: c.errors })),
        },
        null,
        2
      );
    } else if (syncResult && !syncResult.success) {
      syncStep.passed = false;
      syncStep.error = syncResult.error || 'sync_creatives returned unsuccessful result';
    }
    steps.push(syncStep);

    // Step 3: list_creatives without snapshot
    if (profile.tools.includes('list_creatives')) {
      const { result: listResult, step: listStep } = await runStep<TaskResult>(
        'List creatives (no snapshot)',
        'list_creatives',
        async () => client.executeTask('list_creatives', {}) as Promise<TaskResult>
      );

      if (listResult?.success && listResult?.data) {
        const data = listResult.data as any;
        const creatives = data.creatives || [];

        // Validate basic fields on each creative
        const fieldIssues: string[] = [];
        for (const creative of creatives.slice(0, 5)) {
          if (!creative.creative_id) fieldIssues.push('Creative missing creative_id');
          if (!creative.name) fieldIssues.push(`Creative ${creative.creative_id}: missing name`);
          if (!creative.format_id) fieldIssues.push(`Creative ${creative.creative_id}: missing format_id`);
        }

        // Verify snapshot is absent when not requested
        const hasUnexpectedSnapshot = creatives.some((c: any) => c.snapshot !== undefined);

        if (fieldIssues.length > 0) {
          listStep.passed = false;
          listStep.error = `Creative field validation: ${fieldIssues.join('; ')}`;
        } else {
          listStep.details = `Found ${creatives.length} creative(s) with valid fields`;
        }

        listStep.response_preview = JSON.stringify(
          {
            creatives_count: creatives.length,
            statuses: Array.from(new Set(creatives.map((c: any) => c.status))),
            has_unexpected_snapshot: hasUnexpectedSnapshot,
            query_summary: data.query_summary,
          },
          null,
          2
        );

        if (hasUnexpectedSnapshot) {
          listStep.warnings = ['snapshot field present on creatives without include_snapshot=true'];
        }
      } else if (listResult && !listResult.success) {
        listStep.passed = false;
        listStep.error = listResult.error || 'list_creatives returned unsuccessful result';
      }
      steps.push(listStep);

      // Step 4: list_creatives with include_snapshot: true
      const { result: snapshotResult, step: snapshotStep } = await runStep<TaskResult>(
        'List creatives (include_snapshot: true)',
        'list_creatives',
        async () => client.executeTask('list_creatives', { include_snapshot: true }) as Promise<TaskResult>
      );

      if (snapshotResult?.success && snapshotResult?.data) {
        const data = snapshotResult.data as any;
        const creatives = data.creatives || [];

        // Each creative should have either snapshot data or snapshot_unavailable_reason
        const invalidCreatives = creatives.filter((c: any) => {
          if (c.snapshot) {
            return !c.snapshot.as_of || c.snapshot.staleness_seconds === undefined;
          }
          return !c.snapshot_unavailable_reason;
        });

        if (invalidCreatives.length > 0) {
          snapshotStep.passed = false;
          snapshotStep.error = `${invalidCreatives.length} creative(s) missing both snapshot and snapshot_unavailable_reason`;
        } else {
          const withSnapshot = creatives.filter((c: any) => !!c.snapshot).length;
          const withReason = creatives.filter((c: any) => !!c.snapshot_unavailable_reason).length;
          snapshotStep.details = `${creatives.length} creative(s): ${withSnapshot} with snapshot, ${withReason} with unavailable_reason`;
        }

        snapshotStep.response_preview = JSON.stringify(
          {
            creatives_count: creatives.length,
            with_snapshot: creatives.filter((c: any) => !!c.snapshot).length,
            with_unavailable_reason: creatives.filter((c: any) => !!c.snapshot_unavailable_reason).length,
            snapshot_reasons: Array.from(
              new Set(creatives.map((c: any) => c.snapshot_unavailable_reason).filter(Boolean))
            ),
          },
          null,
          2
        );
      } else if (snapshotResult && !snapshotResult.success) {
        snapshotStep.passed = false;
        snapshotStep.error = snapshotResult.error || 'list_creatives with snapshot returned unsuccessful result';
      }
      steps.push(snapshotStep);
    }
  }

  // Step 5: build_creative or preview_creative (adapt to agent capabilities)
  if (profile.tools.includes('build_creative')) {
    const targetFormat = formats[0];
    const { result, step } = await runStep<TaskResult>(
      `Build creative for lifecycle (${targetFormat.format_id})`,
      'build_creative',
      async () =>
        client.executeTask('build_creative', {
          target_format_id: targetFormat.format_id,
          brand: resolveBrand(options),
          message: `Create a ${targetFormat.type || 'display'} ad for lifecycle testing`,
          quality: 'draft',
          include_preview: true,
        }) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as any;
      const manifest = data.creative_manifest || data.creative_manifests?.[0];
      step.details = `Built creative manifest for format ${manifest?.format_id || targetFormat.format_id}`;
      step.response_preview = JSON.stringify(
        {
          format_id: manifest?.format_id || targetFormat.format_id,
          asset_keys: Object.keys(manifest?.assets || {}),
          has_preview: !!data.preview,
        },
        null,
        2
      );
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'build_creative failed';
    }
    steps.push(step);
  } else if (profile.tools.includes('preview_creative')) {
    // Tag-serving agents may only support preview, not build
    const targetFormat = formats[0];
    const { result, step } = await runStep<TaskResult>(
      `Preview creative for lifecycle (${targetFormat.format_id})`,
      'preview_creative',
      async () =>
        client.executeTask('preview_creative', {
          request_type: 'single',
          creative_manifest: {
            format_id: targetFormat.format_id,
            name: 'Lifecycle Test Preview',
            assets: buildTestAssets(targetFormat),
          },
        }) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as any;
      step.details = `Generated preview with ${data.renders?.length || 0} render(s)`;
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'preview_creative failed';
    }
    steps.push(step);
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
