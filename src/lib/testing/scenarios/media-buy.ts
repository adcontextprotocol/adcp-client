/**
 * Media Buy Testing Scenarios
 *
 * Tests sales agent media buy capabilities including:
 * - create_media_buy
 * - update_media_buy
 * - get_media_buy_delivery
 * - sync_creatives
 */

import type {
  AccountReference,
  SyncCreativesSuccess,
  ListCreativesResponse,
  SyncAudiencesSuccess,
  ListAccountsResponse,
} from '../../types/tools.generated';
import type { Product, PricingOption, FormatID } from '../../types/core.generated';
import type { TestOptions, TestStepResult, AgentProfile, TaskResult } from '../types';
import { createTestClient, runStep, discoverAgentProfile, resolveBrand, resolveAccount } from '../client';
import { testDiscovery } from './discovery';

/**
 * Find a suitable product for testing based on options
 */
export function selectProduct(products: Product[], options: TestOptions): Product | null {
  // If channels specified, filter to matching products
  let candidates = products;

  if (options.channels?.length) {
    candidates = products.filter(p => p.channels?.some(ch => options.channels!.includes(ch)));
  }

  // If pricing models specified, filter further
  if (options.pricing_models?.length) {
    candidates = candidates.filter(p =>
      p.pricing_options?.some((po: PricingOption) => options.pricing_models!.includes(po.pricing_model))
    );
  }

  // Return first matching or first product
  return candidates[0] || products[0] || null;
}

/**
 * Select a pricing option from a product
 */
export function selectPricingOption(product: Product, preferredModels?: string[]): PricingOption | null {
  const options = product.pricing_options || [];

  if (preferredModels?.length) {
    const preferred = options.find((po: PricingOption) => preferredModels.includes(po.pricing_model));
    if (preferred) return preferred;
  }

  return options[0] || null;
}

/**
 * Build a create_media_buy request
 */
export function buildCreateMediaBuyRequest(
  product: Product,
  pricingOption: PricingOption,
  options: TestOptions,
  extras: {
    inline_creatives?: Record<string, unknown>[];
    creative_ids?: string[];
  } = {}
): Record<string, unknown> {
  const minSpend = pricingOption.min_spend_per_package || 0;
  const budget = options.budget || Math.max(1000, minSpend);
  const now = new Date();
  const startTime = new Date(now.getTime() + 24 * 60 * 60 * 1000); // Tomorrow
  const endTime = new Date(startTime.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days later

  const isAuction =
    !('fixed_price' in pricingOption) &&
    (pricingOption.floor_price !== undefined || pricingOption.price_guidance !== undefined);

  const packageRequest: Record<string, unknown> = {
    buyer_ref: `pkg-test-${Date.now()}`,
    product_id: product.product_id,
    budget,
    pricing_option_id: pricingOption.pricing_option_id,
  };

  // Add bid_price if auction-based
  if (isAuction && pricingOption.floor_price) {
    packageRequest.bid_price = pricingOption.floor_price * 1.5;
  }

  // Add inline creatives if provided
  if (extras.inline_creatives?.length) {
    packageRequest.creatives = extras.inline_creatives;
  }

  // Add creative references if provided
  if (extras.creative_ids?.length) {
    packageRequest.creative_ids = extras.creative_ids;
  }

  return {
    buyer_ref: `e2e-test-${Date.now()}`,
    account: resolveAccount(options),
    brand: resolveBrand(options),
    start_time: startTime.toISOString(),
    end_time: endTime.toISOString(),
    packages: [packageRequest],
  };
}

function getDefaultFormatId(): FormatID {
  return { agent_url: 'https://creative.adcontextprotocol.org', id: 'display_300x250' };
}

function formatIdToString(formatId: FormatID): string {
  return formatId.id;
}

function selectFormatId(product: Product, fallback: FormatID = getDefaultFormatId()): FormatID {
  if (!product?.format_ids?.length) {
    return fallback;
  }

  const format = product.format_ids[0] as unknown as string | FormatID | { format_id?: FormatID };
  if (typeof format === 'string') {
    return { ...fallback, id: format };
  }

  const nested = format as { format_id?: FormatID };
  if (nested.format_id) {
    return nested.format_id;
  }

  const direct = format as Partial<FormatID>;
  if (typeof direct.agent_url === 'string' && typeof direct.id === 'string') {
    return direct as FormatID;
  }

  return fallback;
}

function buildStaticInlineCreative(formatId: FormatID) {
  const ts = Date.now();
  return {
    creative_id: `test-inline-${ts}`,
    name: `Inline Test Creative ${ts}`,
    format_id: formatId,
    assets: {
      primary: {
        url: 'https://via.placeholder.com/300x250?text=Inline+Creative',
        width: 300,
        height: 250,
        format: 'png',
      },
    },
  };
}

function extractCreativeManifest(data: any): any | undefined {
  return data?.creative_manifest || data?.creative_manifests?.[0];
}

function buildSyncCreativeFromManifest(manifest: any, fallbackFormatId: FormatID) {
  const creativeId = manifest?.creative_id || `test-creative-${Date.now()}`;
  return {
    creative_id: creativeId,
    name: manifest?.name || `Generated Creative ${creativeId}`,
    format_id: manifest?.format_id || fallbackFormatId,
    assets: manifest?.assets || buildStaticInlineCreative(fallbackFormatId).assets,
  };
}

/**
 * Test: Create Media Buy
 * Discovers products, then creates a test media buy
 */
export async function testCreateMediaBuy(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile; mediaBuyId?: string }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, options.protocol || 'mcp', options);

  // First run discovery
  const { steps: discoverySteps, profile } = await testDiscovery(agentUrl, options);
  steps.push(...discoverySteps);

  if (!profile?.tools.includes('create_media_buy')) {
    steps.push({
      step: 'Create media buy',
      task: 'create_media_buy',
      passed: false,
      duration_ms: 0,
      error: 'Agent does not support create_media_buy',
    });
    return { steps, profile };
  }

  // Get products
  const { result: productsResult } = await runStep<TaskResult>(
    'Fetch products for media buy',
    'get_products',
    async () =>
      client.getProducts({
        buying_mode: 'brief',
        brief: options.brief || 'Looking for display advertising products',
        brand: resolveBrand(options),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional: test request bypasses strict typing
      } as any) as Promise<TaskResult>
  );

  const productsData = productsResult?.data as Record<string, unknown> | undefined;
  const products = productsData?.products as Product[] | undefined;
  if (!productsResult?.success || !products?.length) {
    steps.push({
      step: 'Create media buy',
      task: 'create_media_buy',
      passed: false,
      duration_ms: 0,
      error: 'No products available to create media buy',
    });
    return { steps, profile };
  }

  const product = selectProduct(products, options);
  if (!product) {
    steps.push({
      step: 'Create media buy',
      task: 'create_media_buy',
      passed: false,
      duration_ms: 0,
      error: 'No suitable product found',
    });
    return { steps, profile };
  }
  const pricingOption = selectPricingOption(product, options.pricing_models);

  if (!pricingOption) {
    steps.push({
      step: 'Create media buy',
      task: 'create_media_buy',
      passed: false,
      duration_ms: 0,
      error: `Product "${product.name}" has no pricing options`,
    });
    return { steps, profile };
  }

  const createRequest = buildCreateMediaBuyRequest(product, pricingOption, options);

  // Create the media buy
  const { result: createResult, step: createStep } = await runStep<TaskResult>(
    'Create media buy',
    'create_media_buy',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional: test request bypasses strict typing
    async () => client.createMediaBuy(createRequest as any) as Promise<TaskResult>
  );

  let mediaBuyId: string | undefined;

  if (createResult?.success && createResult?.data) {
    const mediaBuy = createResult.data as unknown as Record<string, unknown>;
    const nested = mediaBuy.media_buy as Record<string, unknown> | undefined;
    mediaBuyId = (mediaBuy.media_buy_id || nested?.media_buy_id) as string | undefined;
    const status = (mediaBuy.status || nested?.status) as string | undefined;
    const packages = (mediaBuy.packages || nested?.packages) as unknown[] | undefined;
    createStep.details = `Created media buy: ${mediaBuyId}, status: ${status}`;
    createStep.created_id = mediaBuyId;
    createStep.response_preview = JSON.stringify(
      {
        media_buy_id: mediaBuyId,
        status,
        packages_count: packages?.length,
        pricing_model: pricingOption.pricing_model,
        product_name: product.name,
      },
      null,
      2
    );
  } else if (createResult && !createResult.success) {
    createStep.passed = false;
    createStep.error = createResult.error || 'create_media_buy returned unsuccessful result';
  }
  steps.push(createStep);

  return { steps, profile, mediaBuyId };
}

/**
 * Test: Full Sales Flow
 * Complete lifecycle: discovery -> create -> update -> delivery
 */
export async function testFullSalesFlow(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, options.protocol || 'mcp', options);

  // Run create media buy flow first
  const { steps: createSteps, profile, mediaBuyId } = await testCreateMediaBuy(agentUrl, options);
  steps.push(...createSteps);

  if (!mediaBuyId) {
    return { steps, profile };
  }

  // Test update_media_buy if available
  if (profile?.tools.includes('update_media_buy')) {
    const { result: updateResult, step: updateStep } = await runStep<TaskResult>(
      'Update media buy (increase budget)',
      'update_media_buy',
      async () =>
        client.updateMediaBuy({
          media_buy_id: mediaBuyId,
          packages: [
            {
              package_id: 'pkg-0',
              budget: (options.budget || 1000) * 1.5,
            },
          ],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional: test request bypasses strict typing
        } as any) as Promise<TaskResult>
    );

    if (updateResult?.success && updateResult?.data) {
      const data = updateResult.data as unknown as Record<string, unknown>;
      const nested = data.media_buy as Record<string, unknown> | undefined;
      const status = (data.status || nested?.status) as string | undefined;
      updateStep.details = `Updated media buy, status: ${status}`;
      updateStep.response_preview = JSON.stringify(
        {
          media_buy_id: (data.media_buy_id || nested?.media_buy_id) as string | undefined,
          status,
        },
        null,
        2
      );
    } else if (updateResult && !updateResult.success) {
      updateStep.passed = false;
      updateStep.error = updateResult.error || 'update_media_buy returned unsuccessful result';
    }
    steps.push(updateStep);
  }

  if (profile?.tools.includes('get_media_buys')) {
    const { result: snapshotResult, step: snapshotStep } = await runStep<TaskResult>(
      'Get media buy status with delivery snapshots',
      'get_media_buys',
      async () =>
        client.executeTask('get_media_buys', {
          media_buy_ids: [mediaBuyId],
          include_snapshot: true,
        }) as Promise<TaskResult>
    );

    if (snapshotResult?.success && snapshotResult?.data) {
      const mediaBuys = snapshotResult.data.media_buys || [];
      const mediaBuy = mediaBuys.find((item: any) => item.media_buy_id === mediaBuyId) || mediaBuys[0];
      const packages = mediaBuy?.packages || [];
      const invalidPackages = packages.filter((pkg: any) => {
        if (pkg.snapshot) {
          return !pkg.snapshot.as_of || pkg.snapshot.staleness_seconds === undefined;
        }
        return !pkg.snapshot_unavailable_reason;
      });

      if (!mediaBuy) {
        snapshotStep.passed = false;
        snapshotStep.error = 'get_media_buys did not return the created media buy';
      } else if (invalidPackages.length > 0) {
        snapshotStep.passed = false;
        snapshotStep.error =
          'include_snapshot=true must return either snapshot data or snapshot_unavailable_reason for each package';
      } else {
        snapshotStep.details = `Retrieved ${packages.length} package snapshot(s)`;
        snapshotStep.response_preview = JSON.stringify(
          {
            media_buy_id: mediaBuy.media_buy_id,
            package_count: packages.length,
            snapshots_returned: packages.filter((pkg: any) => !!pkg.snapshot).length,
            snapshot_unavailable: packages
              .filter((pkg: any) => !!pkg.snapshot_unavailable_reason)
              .map((pkg: any) => ({ package_id: pkg.package_id, reason: pkg.snapshot_unavailable_reason })),
          },
          null,
          2
        );
      }
    } else if (snapshotResult && !snapshotResult.success) {
      snapshotStep.passed = false;
      snapshotStep.error = snapshotResult.error || 'get_media_buys returned unsuccessful result';
    }
    steps.push(snapshotStep);
  }

  // Test get_media_buy_delivery if available
  if (profile?.tools.includes('get_media_buy_delivery')) {
    const { result: deliveryResult, step: deliveryStep } = await runStep<TaskResult>(
      'Get delivery metrics',
      'get_media_buy_delivery',
      async () =>
        client.getMediaBuyDelivery({
          media_buy_ids: [mediaBuyId],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional: test request bypasses strict typing
        } as any) as Promise<TaskResult>
    );

    if (deliveryResult?.success && deliveryResult?.data) {
      const delivery = deliveryResult.data as unknown as Record<string, unknown>;
      const deliveries = delivery.deliveries as unknown[] | undefined;
      const mediaBuys = delivery.media_buys as unknown[] | undefined;
      deliveryStep.details = `Retrieved delivery metrics`;
      deliveryStep.response_preview = JSON.stringify(
        {
          has_deliveries: !!(deliveries?.length || mediaBuys?.length),
        },
        null,
        2
      );
    } else if (deliveryResult && !deliveryResult.success) {
      deliveryStep.passed = false;
      deliveryStep.error = deliveryResult.error || 'get_media_buy_delivery returned unsuccessful result';
    }
    steps.push(deliveryStep);
  }

  return { steps, profile };
}

/**
 * Test: Creative Sync Flow
 * Tests sync_creatives separately from create_media_buy
 */
export async function testCreativeSync(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, options.protocol || 'mcp', options);

  // Discover profile
  const { profile, step: profileStep } = await discoverAgentProfile(client);
  steps.push(profileStep);

  if (!profile.tools.includes('sync_creatives')) {
    steps.push({
      step: 'Sync creatives',
      task: 'sync_creatives',
      passed: false,
      duration_ms: 0,
      error: 'Agent does not support sync_creatives',
    });
    return { steps, profile };
  }

  // Get format info first
  let formatId: Record<string, unknown> = {
    agent_url: 'https://creative.adcontextprotocol.org',
    id: 'display_300x250',
  };
  if (profile.tools.includes('list_creative_formats')) {
    const { result: formatsResult } = await runStep<TaskResult>(
      'Get formats for creative',
      'list_creative_formats',
      async () => client.listCreativeFormats({}) as Promise<TaskResult>
    );

    if (formatsResult?.success && formatsResult?.data) {
      const data = formatsResult.data as unknown as Record<string, unknown>;
      const formatIds = data.format_ids as unknown[] | undefined;
      const formats = data.formats as Record<string, unknown>[] | undefined;
      const firstFormat = formatIds?.[0] || formats?.[0];
      if (firstFormat) {
        if (typeof firstFormat === 'string') {
          formatId = { id: firstFormat };
        } else {
          const formatObj = firstFormat as Record<string, unknown>;
          formatId = (formatObj.format_id as Record<string, unknown>) || formatObj;
        }
      }
    }
  }

  // Test sync_creatives with a simple creative
  // Assets must be an object keyed by asset_role, not an array
  const testCreative = {
    creative_id: `test-creative-${Date.now()}`,
    name: 'E2E Test Creative',
    format_id: formatId,
    assets: {
      primary: {
        url: 'https://via.placeholder.com/300x250',
        width: 300,
        height: 250,
        format: 'png',
      },
    },
  };

  const { result: syncResult, step: syncStep } = await runStep<TaskResult>(
    'Sync creative to library',
    'sync_creatives',
    async () =>
      client.syncCreatives({
        account: resolveAccount(options),
        creatives: [testCreative],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional: test request bypasses strict typing
      } as any) as Promise<TaskResult>
  );

  if (syncResult?.success && syncResult?.data) {
    const data = syncResult.data as unknown as SyncCreativesSuccess;
    const creatives = data.creatives || [];
    const actions = creatives.map(c => c.action);
    syncStep.details = `Synced ${creatives.length} creative(s), actions: ${actions.join(', ')}`;
    syncStep.response_preview = JSON.stringify(
      {
        creatives_count: creatives.length,
        actions: actions,
        creative_ids: creatives.map(c => c.creative_id),
      },
      null,
      2
    );
  } else if (syncResult && !syncResult.success) {
    syncStep.passed = false;
    syncStep.error = syncResult.error || 'sync_creatives returned unsuccessful result';
  }
  steps.push(syncStep);

  // Test list_creatives if available
  if (profile.tools.includes('list_creatives')) {
    const { result: listResult, step: listStep } = await runStep<TaskResult>(
      'List creatives in library',
      'list_creatives',
      async () => client.listCreatives({}) as Promise<TaskResult>
    );

    if (listResult?.success && listResult?.data) {
      const data = listResult.data as unknown as ListCreativesResponse;
      const creatives = data.creatives || [];
      const querySummary = data.query_summary;
      const totalMatching = querySummary?.total_matching;
      const returned = querySummary?.returned ?? creatives.length;

      // Check for pagination bug: total_matching > 0 but returned = 0
      if (totalMatching !== undefined && totalMatching > 0 && returned === 0) {
        listStep.passed = false;
        listStep.error = `Pagination bug: query_summary shows ${totalMatching} total_matching but returned ${returned} creatives`;
        listStep.response_preview = JSON.stringify(
          {
            total_matching: totalMatching,
            returned,
            creatives_count: creatives.length,
            pagination: data.pagination,
          },
          null,
          2
        );
      } else {
        listStep.details = `Found ${creatives.length} creative(s) in library`;
        listStep.response_preview = JSON.stringify(
          {
            creatives_count: creatives.length,
            total_matching: totalMatching,
            statuses: Array.from(new Set(creatives.map(c => c.status))),
          },
          null,
          2
        );
      }
    } else if (listResult && !listResult.success) {
      listStep.passed = false;
      listStep.error = listResult.error || 'list_creatives returned unsuccessful result';
    }
    steps.push(listStep);
  }

  return { steps, profile };
}

/**
 * Test: Creative Inline Flow
 * Tests providing creatives inline in create_media_buy
 */
export async function testCreativeInline(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, options.protocol || 'mcp', options);

  // Discovery first
  const { steps: discoverySteps, profile } = await testDiscovery(agentUrl, options);
  steps.push(...discoverySteps);

  if (!profile?.tools.includes('create_media_buy')) {
    steps.push({
      step: 'Create media buy with inline creatives',
      task: 'create_media_buy',
      passed: false,
      duration_ms: 0,
      error: 'Agent does not support create_media_buy',
    });
    return { steps, profile };
  }

  // Check if agent declares inline creative support via capabilities
  if (profile.tools.includes('get_adcp_capabilities')) {
    try {
      const capResult = (await client.getAdcpCapabilities({})) as TaskResult | undefined;
      const capData = capResult?.data as Record<string, any> | undefined;
      if (capData?.media_buy?.features?.inline_creative_management === false) {
        steps.push({
          step: 'Create media buy with inline creative',
          task: 'create_media_buy',
          passed: true,
          duration_ms: 0,
          details: 'Skipped: agent declares inline_creative_management: false',
        });
        return { steps, profile };
      }
    } catch {
      // If capabilities check fails, proceed with the test
    }
  }

  // Get products
  const { result: productsResult } = await runStep<TaskResult>(
    'Fetch products for inline creative test',
    'get_products',
    async () =>
      client.getProducts({
        buying_mode: 'brief',
        brief: options.brief || 'Looking for display advertising products',
        brand: resolveBrand(options),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional: test request bypasses strict typing
      } as any) as Promise<TaskResult>
  );

  const inlineProductsData = productsResult?.data as Record<string, unknown> | undefined;
  const products = inlineProductsData?.products as Product[] | undefined;
  if (!productsResult?.success || !products?.length) {
    steps.push({
      step: 'Create media buy with inline creatives',
      task: 'create_media_buy',
      passed: false,
      duration_ms: 0,
      error: 'No products available to test inline creatives',
    });
    return { steps, profile };
  }

  const product = selectProduct(products, options);
  if (!product) {
    steps.push({
      step: 'Create media buy with inline creatives',
      task: 'create_media_buy',
      passed: false,
      duration_ms: 0,
      error: 'No suitable product found',
    });
    return { steps, profile };
  }
  const pricingOption = selectPricingOption(product, options.pricing_models);

  if (!pricingOption) {
    steps.push({
      step: 'Create media buy with inline creatives',
      task: 'create_media_buy',
      passed: false,
      duration_ms: 0,
      error: `Product "${product.name}" has no pricing options`,
    });
    return { steps, profile };
  }

  const formatId = selectFormatId(product);
  let inlineCreative = buildStaticInlineCreative(formatId);

  if (profile.tools.includes('build_creative')) {
    const { result: buildResult, step: buildStep } = await runStep<TaskResult>(
      `Build creative for inline flow (${formatIdToString(formatId)})`,
      'build_creative',
      async () =>
        client.executeTask('build_creative', {
          target_format_id: formatId,
          brand: resolveBrand(options),
          message: `Create an ad creative for the ${formatIdToString(formatId)} format that can be attached to a media buy`,
          quality: 'draft',
        }) as Promise<TaskResult>
    );

    if (buildResult?.success && buildResult?.data) {
      const manifest = extractCreativeManifest(buildResult.data);
      if (manifest?.assets) {
        inlineCreative = buildSyncCreativeFromManifest(manifest, formatId);
        buildStep.details = `Built creative manifest for ${inlineCreative.format_id}`;
        buildStep.response_preview = JSON.stringify(
          {
            format_id: inlineCreative.format_id,
            asset_keys: Object.keys(inlineCreative.assets || {}),
          },
          null,
          2
        );
      } else {
        buildStep.passed = false;
        buildStep.error = 'build_creative succeeded but returned no creative_manifest';
      }
    } else if (buildResult && !buildResult.success) {
      buildStep.passed = false;
      buildStep.error = buildResult.error || 'build_creative failed';
    }
    steps.push(buildStep);
  }

  const createRequest = buildCreateMediaBuyRequest(product, pricingOption, options, {
    inline_creatives: [inlineCreative],
  });

  const { result: createResult, step: createStep } = await runStep<TaskResult>(
    'Create media buy with inline creative',
    'create_media_buy',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional: test request bypasses strict typing
    async () => client.createMediaBuy(createRequest as any) as Promise<TaskResult>
  );

  if (createResult?.success && createResult?.data) {
    const mediaBuy = createResult.data as unknown as Record<string, unknown>;
    const nested = mediaBuy.media_buy as Record<string, unknown> | undefined;
    const mediaBuyId = (mediaBuy.media_buy_id || nested?.media_buy_id) as string | undefined;
    const status = (mediaBuy.status || nested?.status) as string | undefined;
    const packages = (mediaBuy.packages || nested?.packages) as Record<string, unknown>[] | undefined;
    const hasCreatives = packages?.some(p => {
      const creatives = p.creatives as unknown[] | undefined;
      const creativeIds = p.creative_ids as unknown[] | undefined;
      return creatives?.length || creativeIds?.length;
    });

    createStep.details = `Created media buy with inline creative: ${mediaBuyId}`;
    createStep.created_id = mediaBuyId;
    createStep.response_preview = JSON.stringify(
      {
        media_buy_id: mediaBuyId,
        status,
        has_creatives: hasCreatives,
        packages_count: packages?.length,
      },
      null,
      2
    );
  } else if (createResult && !createResult.success) {
    createStep.passed = false;
    createStep.error = createResult.error || 'create_media_buy with inline creatives failed';
  }
  steps.push(createStep);

  return { steps, profile };
}

/**
 * Test: Creative Reference Flow
 * Builds a creative manifest, syncs it into the seller's library, then references it in create_media_buy.
 */
export async function testCreativeReference(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, options.protocol || 'mcp', options);

  const { steps: discoverySteps, profile } = await testDiscovery(agentUrl, options);
  steps.push(...discoverySteps);

  if (!profile?.tools.includes('build_creative') || !profile.tools.includes('sync_creatives')) {
    steps.push({
      step: 'Build and reference creative',
      task: 'build_creative',
      passed: false,
      duration_ms: 0,
      error: 'Agent must support both build_creative and sync_creatives',
    });
    return { steps, profile };
  }

  const { result: productsResult } = await runStep<TaskResult>(
    'Fetch products for creative reference test',
    'get_products',
    async () =>
      client.executeTask('get_products', {
        buying_mode: 'brief',
        brief: options.brief || 'Looking for products that support generated creative attachments',
        brand: resolveBrand(options),
      }) as Promise<TaskResult>
  );

  const products = productsResult?.data?.products as any[] | undefined;
  if (!productsResult?.success || !products?.length) {
    steps.push({
      step: 'Build and reference creative',
      task: 'create_media_buy',
      passed: false,
      duration_ms: 0,
      error: 'No products available to test creative references',
    });
    return { steps, profile };
  }

  const product = selectProduct(products, options);
  if (!product) {
    steps.push({
      step: 'Build and reference creative',
      task: 'create_media_buy',
      passed: false,
      duration_ms: 0,
      error: 'No suitable product found for creative reference test',
    });
    return { steps, profile };
  }

  const pricingOption = selectPricingOption(product, options.pricing_models);
  const formatId = selectFormatId(product);

  if (!pricingOption) {
    steps.push({
      step: 'Build and reference creative',
      task: 'create_media_buy',
      passed: false,
      duration_ms: 0,
      error: `Product "${product.name}" has no pricing options`,
    });
    return { steps, profile };
  }

  const { result: buildResult, step: buildStep } = await runStep<TaskResult>(
    `Build creative for reference flow (${formatIdToString(formatId)})`,
    'build_creative',
    async () =>
      client.executeTask('build_creative', {
        target_format_id: formatId,
        brand: resolveBrand(options),
        message: `Create a reusable ad creative for the ${formatIdToString(formatId)} format`,
        quality: 'draft',
      }) as Promise<TaskResult>
  );

  if (!buildResult?.success || !buildResult?.data) {
    buildStep.passed = false;
    buildStep.error = buildResult?.error || 'build_creative failed';
    steps.push(buildStep);
    return { steps, profile };
  }

  const manifest = extractCreativeManifest(buildResult.data);
  if (!manifest?.assets) {
    buildStep.passed = false;
    buildStep.error = 'build_creative returned no creative_manifest';
    steps.push(buildStep);
    return { steps, profile };
  }

  const syncedCreative = buildSyncCreativeFromManifest(manifest, formatId);
  buildStep.details = `Built creative manifest for ${syncedCreative.format_id}`;
  buildStep.response_preview = JSON.stringify(
    {
      creative_id: syncedCreative.creative_id,
      format_id: syncedCreative.format_id,
      asset_keys: Object.keys(syncedCreative.assets || {}),
    },
    null,
    2
  );
  steps.push(buildStep);

  const { result: syncResult, step: syncStep } = await runStep<TaskResult>(
    'Sync generated creative to library',
    'sync_creatives',
    async () =>
      client.executeTask('sync_creatives', {
        creatives: [syncedCreative],
      }) as Promise<TaskResult>
  );

  if (!syncResult?.success || !syncResult?.data) {
    syncStep.passed = false;
    syncStep.error = syncResult?.error || 'sync_creatives failed';
    steps.push(syncStep);
    return { steps, profile };
  }

  syncStep.details = `Synced creative ${syncedCreative.creative_id} to seller library`;
  syncStep.created_id = syncedCreative.creative_id;
  syncStep.response_preview = JSON.stringify(
    {
      creative_id: syncedCreative.creative_id,
      synced_count: (syncResult.data.creatives || []).length,
    },
    null,
    2
  );
  steps.push(syncStep);

  const createRequest = buildCreateMediaBuyRequest(product, pricingOption, options, {
    creative_ids: [syncedCreative.creative_id],
  });

  const { result: createResult, step: createStep } = await runStep<TaskResult>(
    'Create media buy with referenced creative',
    'create_media_buy',
    async () => client.executeTask('create_media_buy', createRequest) as Promise<TaskResult>
  );

  if (createResult?.success && createResult?.data) {
    const mediaBuy = createResult.data;
    const mediaBuyId = mediaBuy.media_buy_id || mediaBuy.media_buy?.media_buy_id;
    const packages = mediaBuy.packages || mediaBuy.media_buy?.packages;
    const referenced = packages?.some((pkg: any) => pkg.creative_ids?.includes(syncedCreative.creative_id));
    createStep.details = `Created media buy with referenced creative ${syncedCreative.creative_id}`;
    createStep.created_id = mediaBuyId;
    createStep.response_preview = JSON.stringify(
      {
        media_buy_id: mediaBuyId,
        creative_id: syncedCreative.creative_id,
        referenced,
      },
      null,
      2
    );
  } else if (createResult && !createResult.success) {
    createStep.passed = false;
    createStep.error = createResult.error || 'create_media_buy with creative_ids failed';
  }
  steps.push(createStep);

  return { steps, profile };
}

// SHA-256 lookalike placeholder for test email/phone hashes (not a real hash)
const TEST_HASHED_EMAIL = 'a' + '0'.repeat(63);
const TEST_HASHED_PHONE = 'b' + '0'.repeat(63);

/**
 * Resolve which account reference to use for audience sync.
 *
 * Priority: explicit account_id > sandbox discovery > sandbox natural key > list_accounts discovery.
 *
 * Extracted for testability — the listAccounts callback abstracts the client call.
 */
export async function resolveAccountForAudiences(
  options: TestOptions,
  tools: string[],
  listAccounts: (params: Record<string, unknown>) => Promise<TaskResult>
): Promise<{ accountRef: AccountReference | undefined; steps: TestStepResult[] }> {
  const steps: TestStepResult[] = [];

  if (options.audience_account_id) {
    return { accountRef: { account_id: options.audience_account_id }, steps };
  }

  if (options.sandbox && tools.includes('list_accounts')) {
    // Sandbox with list_accounts: try explicit sandbox path first (discover pre-existing test accounts)
    const { result: sandboxResult, step: sandboxStep } = await runStep<TaskResult>(
      'Discover sandbox accounts',
      'list_accounts',
      async () => listAccounts({ sandbox: true })
    );

    const sandboxData = sandboxResult?.success
      ? (sandboxResult.data as unknown as ListAccountsResponse | undefined)
      : undefined;
    const sandboxAccounts = sandboxData?.accounts ?? [];
    if (sandboxAccounts[0]?.account_id) {
      sandboxStep.details = `Using sandbox account: ${sandboxAccounts[0].account_id}`;
      steps.push(sandboxStep);
      return { accountRef: { account_id: sandboxAccounts[0].account_id }, steps };
    }

    // Fall back to natural key — mark step as informational, not a failure
    const brand = resolveBrand(options);
    if (!sandboxResult?.success) {
      sandboxStep.details = 'list_accounts failed; falling back to natural key';
    } else {
      sandboxStep.details = 'No explicit sandbox accounts found; falling back to natural key';
    }
    sandboxStep.passed = true;
    sandboxStep.error = undefined;
    steps.push(sandboxStep);
    return { accountRef: { brand, operator: brand.domain, sandbox: true }, steps };
  }

  if (options.sandbox) {
    // Sandbox without list_accounts: implicit account model, use natural key
    const brand = resolveBrand(options);
    return { accountRef: { brand, operator: brand.domain, sandbox: true }, steps };
  }

  if (tools.includes('list_accounts')) {
    const { result: accountsResult, step: accountsStep } = await runStep<TaskResult>(
      'Discover accounts for audience sync',
      'list_accounts',
      async () => listAccounts({})
    );

    if (accountsResult?.success && accountsResult?.data) {
      const accountsData = accountsResult.data as unknown as ListAccountsResponse;
      const accounts = accountsData.accounts ?? [];
      if (accounts[0]?.account_id) {
        accountsStep.details = `Using account: ${accounts[0].account_id}`;
        steps.push(accountsStep);
        return { accountRef: { account_id: accounts[0].account_id }, steps };
      }
      accountsStep.details = 'list_accounts returned no accounts';
    } else {
      accountsStep.details = 'list_accounts call failed';
    }
    steps.push(accountsStep);
  }

  return { accountRef: undefined, steps };
}

/**
 * Test: Audience Sync
 * Tests sync_audiences: discovery -> create audience -> delete audience
 */
export async function testSyncAudiences(
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

  if (!profile.tools.includes('sync_audiences')) {
    steps.push({
      step: 'Sync audiences',
      task: 'sync_audiences',
      passed: false,
      duration_ms: 0,
      error: 'Agent does not support sync_audiences',
    });
    return { steps, profile };
  }

  const { accountRef, steps: accountSteps } = await resolveAccountForAudiences(
    options,
    profile.tools,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional: test request bypasses strict typing
    async params => client.listAccounts(params as any) as Promise<TaskResult>
  );
  steps.push(...accountSteps);

  if (!accountRef) {
    steps.push({
      step: 'Sync audiences',
      task: 'sync_audiences',
      passed: false,
      duration_ms: 0,
      error:
        'No account available. Provide audience_account_id, use sandbox: true, or ensure list_accounts is supported.',
    });
    return { steps, profile };
  }

  // Step 1: Discovery call — list existing audiences without modification
  const { result: discoveryResult, step: discoveryStep } = await runStep<TaskResult>(
    'Discover existing audiences (discovery-only)',
    'sync_audiences',
    async () =>
      client.syncAudiences({
        account: accountRef,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional: test request bypasses strict typing
      } as any) as Promise<TaskResult>
  );

  if (discoveryResult?.success && discoveryResult?.data) {
    const discoveryData = discoveryResult.data as unknown as SyncAudiencesSuccess;
    const audiences = discoveryData.audiences ?? [];
    discoveryStep.details = `Found ${audiences.length} existing audience(s)`;
    discoveryStep.response_preview = JSON.stringify(
      {
        existing_audiences: audiences.length,
        audience_ids: audiences.map(a => a.audience_id).slice(0, 5),
      },
      null,
      2
    );
  } else if (discoveryResult && !discoveryResult.success) {
    discoveryStep.passed = false;
    discoveryStep.error = discoveryResult.error || 'sync_audiences discovery call failed';
  }
  steps.push(discoveryStep);

  if (!discoveryResult?.success) {
    return { steps, profile };
  }

  // Step 2: Create a test audience
  const testAudienceId = `adcp-test-audience-${Date.now()}`;

  const { result: createResult, step: createStep } = await runStep<TaskResult>(
    'Create test audience',
    'sync_audiences',
    async () =>
      client.syncAudiences({
        account: accountRef,
        audiences: [
          {
            audience_id: testAudienceId,
            name: 'AdCP E2E Test Audience',
            add: [{ hashed_email: TEST_HASHED_EMAIL }, { hashed_phone: TEST_HASHED_PHONE }],
          },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional: test request bypasses strict typing
      } as any) as Promise<TaskResult>
  );

  if (createResult?.success && createResult?.data) {
    const createData = createResult.data as unknown as SyncAudiencesSuccess;
    const audiences = createData.audiences ?? [];
    const testAudience = audiences.find(a => a.audience_id === testAudienceId);
    createStep.details = `Created audience "${testAudienceId}", action: ${testAudience?.action}, status: ${testAudience?.status ?? 'n/a'}`;
    createStep.created_id = testAudienceId;
    createStep.response_preview = JSON.stringify(
      {
        audience_id: testAudience?.audience_id,
        action: testAudience?.action,
        status: testAudience?.status,
        uploaded_count: testAudience?.uploaded_count,
      },
      null,
      2
    );
  } else if (createResult && !createResult.success) {
    createStep.passed = false;
    createStep.error = createResult.error || 'sync_audiences create call failed';
  }
  steps.push(createStep);

  if (!createResult?.success) {
    return { steps, profile };
  }

  // Step 3: Delete the test audience
  const { result: deleteResult, step: deleteStep } = await runStep<TaskResult>(
    'Delete test audience',
    'sync_audiences',
    async () =>
      client.syncAudiences({
        account: accountRef,
        audiences: [
          {
            audience_id: testAudienceId,
            delete: true,
          },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional: test request bypasses strict typing
      } as any) as Promise<TaskResult>
  );

  if (deleteResult?.success && deleteResult?.data) {
    const deleteData = deleteResult.data as unknown as SyncAudiencesSuccess;
    const audiences = deleteData.audiences ?? [];
    const deleted = audiences.find(a => a.audience_id === testAudienceId);
    deleteStep.details = `Deleted audience "${testAudienceId}", action: ${deleted?.action}`;
    deleteStep.response_preview = JSON.stringify(
      {
        audience_id: deleted?.audience_id,
        action: deleted?.action,
      },
      null,
      2
    );
  } else if (deleteResult && !deleteResult.success) {
    deleteStep.passed = false;
    deleteStep.error = deleteResult.error || 'sync_audiences delete call failed';
  }
  steps.push(deleteStep);

  return { steps, profile };
}

// ---------------------------------------------------------------------------
// State Machine Compliance Scenarios
// ---------------------------------------------------------------------------

/**
 * Extract media buy status from a response, handling nested shapes.
 */
function extractStatus(data: Record<string, unknown>): string | undefined {
  const nested = data.media_buy as Record<string, unknown> | undefined;
  return (data.status ?? nested?.status) as string | undefined;
}

/**
 * Test: Media Buy Lifecycle
 * Exercises the full state machine: create -> pause -> resume -> get status -> cancel
 */
export async function testMediaBuyLifecycle(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, options.protocol || 'mcp', options);

  // Create a media buy to work with
  const { steps: createSteps, profile, mediaBuyId } = await testCreateMediaBuy(agentUrl, options);
  steps.push(...createSteps);

  if (!mediaBuyId || !profile?.tools.includes('update_media_buy')) {
    return { steps, profile };
  }

  // Step 1: Pause the media buy
  const { result: pauseResult, step: pauseStep } = await runStep<TaskResult>(
    'Pause media buy',
    'update_media_buy',
    async () =>
      client.updateMediaBuy({
        media_buy_id: mediaBuyId,
        paused: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional: test request bypasses strict typing
      } as any) as Promise<TaskResult>
  );

  if (pauseResult?.success && pauseResult?.data) {
    const data = pauseResult.data as unknown as Record<string, unknown>;
    const status = extractStatus(data);
    pauseStep.details = `Paused media buy, status: ${status}`;
    pauseStep.response_preview = JSON.stringify({ media_buy_id: mediaBuyId, status }, null, 2);
    if (status && status !== 'paused') {
      pauseStep.warnings = [`Expected status 'paused', got '${status}'`];
    }
  } else if (pauseResult && !pauseResult.success) {
    pauseStep.passed = false;
    pauseStep.error = pauseResult.error || 'Pause operation failed';
  }
  steps.push(pauseStep);

  // Step 2: Resume the media buy
  const { result: resumeResult, step: resumeStep } = await runStep<TaskResult>(
    'Resume media buy',
    'update_media_buy',
    async () =>
      client.updateMediaBuy({
        media_buy_id: mediaBuyId,
        paused: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional: test request bypasses strict typing
      } as any) as Promise<TaskResult>
  );

  if (resumeResult?.success && resumeResult?.data) {
    const data = resumeResult.data as unknown as Record<string, unknown>;
    const status = extractStatus(data);
    resumeStep.details = `Resumed media buy, status: ${status}`;
    resumeStep.response_preview = JSON.stringify({ media_buy_id: mediaBuyId, status }, null, 2);
    if (status && status !== 'active' && status !== 'pending_activation') {
      resumeStep.warnings = [`Expected status 'active' or 'pending_activation', got '${status}'`];
    }
  } else if (resumeResult && !resumeResult.success) {
    resumeStep.passed = false;
    resumeStep.error = resumeResult.error || 'Resume operation failed';
  }
  steps.push(resumeStep);

  // Step 3: Get status and check valid_actions (if get_media_buys available)
  if (profile.tools.includes('get_media_buys')) {
    const { result: statusResult, step: statusStep } = await runStep<TaskResult>(
      'Get media buy status and valid_actions',
      'get_media_buys',
      async () =>
        client.executeTask('get_media_buys', {
          media_buy_ids: [mediaBuyId],
        }) as Promise<TaskResult>
    );

    if (statusResult?.success && statusResult?.data) {
      const mediaBuys = (statusResult.data.media_buys || []) as Array<Record<string, unknown>>;
      const mediaBuy =
        mediaBuys.find((item: Record<string, unknown>) => item.media_buy_id === mediaBuyId) || mediaBuys[0];

      if (!mediaBuy) {
        statusStep.passed = false;
        statusStep.error = 'get_media_buys did not return the created media buy';
      } else {
        const validActions = mediaBuy.valid_actions as string[] | undefined;
        statusStep.details = `Status: ${mediaBuy.status}, valid_actions: ${validActions ? validActions.join(', ') : 'not provided'}`;
        statusStep.response_preview = JSON.stringify(
          {
            media_buy_id: mediaBuy.media_buy_id,
            status: mediaBuy.status,
            valid_actions: validActions,
          },
          null,
          2
        );
      }
    } else if (statusResult && !statusResult.success) {
      statusStep.passed = false;
      statusStep.error = statusResult.error || 'get_media_buys failed';
    }
    steps.push(statusStep);
  }

  // Step 4: Cancel the media buy
  const { result: cancelResult, step: cancelStep } = await runStep<TaskResult>(
    'Cancel media buy',
    'update_media_buy',
    async () =>
      client.updateMediaBuy({
        media_buy_id: mediaBuyId,
        canceled: true,
        cancellation_reason: 'AdCP compliance test — lifecycle scenario',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional: test request bypasses strict typing
      } as any) as Promise<TaskResult>
  );

  if (cancelResult?.success && cancelResult?.data) {
    const data = cancelResult.data as unknown as Record<string, unknown>;
    const status = extractStatus(data);
    cancelStep.details = `Canceled media buy, status: ${status}`;
    cancelStep.response_preview = JSON.stringify({ media_buy_id: mediaBuyId, status }, null, 2);
    if (status && status !== 'canceled') {
      cancelStep.warnings = [`Expected status 'canceled', got '${status}'`];
    }
  } else if (cancelResult && !cancelResult.success) {
    // NOT_CANCELLABLE is a valid response — agent may not support cancellation
    const error = cancelResult.error || '';
    if (error.includes('NOT_CANCELLABLE') || error.includes('not_cancellable')) {
      cancelStep.passed = true;
      cancelStep.details = 'Agent does not support cancellation (NOT_CANCELLABLE)';
    } else {
      cancelStep.passed = false;
      cancelStep.error = cancelResult.error || 'Cancel operation failed';
    }
  }
  steps.push(cancelStep);

  return { steps, profile };
}

/**
 * Test: Terminal State Enforcement
 * Verifies agents reject updates to media buys in terminal states.
 */
export async function testTerminalStateEnforcement(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, options.protocol || 'mcp', options);

  // Create and cancel a media buy
  const { steps: createSteps, profile, mediaBuyId } = await testCreateMediaBuy(agentUrl, options);
  steps.push(...createSteps);

  if (!mediaBuyId || !profile?.tools.includes('update_media_buy')) {
    return { steps, profile };
  }

  // Cancel the media buy to put it in a terminal state
  const { result: cancelResult, step: cancelStep } = await runStep<TaskResult>(
    'Cancel media buy (setup)',
    'update_media_buy',
    async () =>
      client.updateMediaBuy({
        media_buy_id: mediaBuyId,
        canceled: true,
        cancellation_reason: 'AdCP compliance test — terminal state enforcement',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional: test request bypasses strict typing
      } as any) as Promise<TaskResult>
  );

  if (cancelResult?.success && cancelResult?.data) {
    const data = cancelResult.data as unknown as Record<string, unknown>;
    cancelStep.details = `Canceled media buy, status: ${extractStatus(data)}`;
  } else if (cancelResult && !cancelResult.success) {
    const error = cancelResult.error || '';
    if (error.includes('NOT_CANCELLABLE') || error.includes('not_cancellable')) {
      // Agent doesn't support cancellation — can't test terminal state enforcement
      cancelStep.passed = true;
      cancelStep.details = 'Agent does not support cancellation — skipping terminal state tests';
      steps.push(cancelStep);
      return { steps, profile };
    }
    cancelStep.passed = false;
    cancelStep.error = cancelResult.error || 'Cancel setup failed';
  }
  steps.push(cancelStep);

  // Try to pause the canceled media buy — should be rejected
  const { result: pauseResult, step: pauseStep } = await runStep<TaskResult>(
    'Update canceled media buy (expect rejection)',
    'update_media_buy',
    async () =>
      client.updateMediaBuy({
        media_buy_id: mediaBuyId,
        paused: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional: test request bypasses strict typing
      } as any) as Promise<TaskResult>
  );

  if (pauseResult?.success) {
    pauseStep.passed = false;
    pauseStep.error = 'Agent accepted update to canceled media buy — should reject with INVALID_STATE';
  } else if (pauseResult) {
    // Agent returned { success: false } — correct behavior
    pauseStep.passed = true;
    const error = pauseResult.error || '';
    const hasExpectedCode = error.includes('INVALID_STATE') || error.includes('invalid_state');
    pauseStep.details = hasExpectedCode
      ? 'Correctly rejected with INVALID_STATE'
      : `Correctly rejected update to canceled media buy: ${error}`;
    if (!hasExpectedCode && error) {
      pauseStep.warnings = ['Agent rejected the update but did not use INVALID_STATE error code'];
    }
  }
  // else: pauseResult is undefined (exception thrown) — runStep already set passed=false and error
  steps.push(pauseStep);

  // Try to cancel again — should also be rejected (or idempotent)
  const { result: reCancelResult, step: reCancelStep } = await runStep<TaskResult>(
    'Cancel already-canceled media buy (expect rejection)',
    'update_media_buy',
    async () =>
      client.updateMediaBuy({
        media_buy_id: mediaBuyId,
        canceled: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional: test request bypasses strict typing
      } as any) as Promise<TaskResult>
  );

  if (reCancelResult?.success) {
    // Idempotent cancellation is acceptable
    reCancelStep.passed = true;
    reCancelStep.details = 'Agent accepted re-cancellation (idempotent) — acceptable behavior';
  } else if (reCancelResult) {
    reCancelStep.passed = true;
    const error = reCancelResult.error || '';
    reCancelStep.details = `Correctly rejected re-cancellation: ${error}`;
  }
  steps.push(reCancelStep);

  return { steps, profile };
}

/**
 * Test: Package Lifecycle
 * Tests package-level pause/resume independent of media buy status.
 */
export async function testPackageLifecycle(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = createTestClient(agentUrl, options.protocol || 'mcp', options);

  // Create a media buy
  const { steps: createSteps, profile, mediaBuyId } = await testCreateMediaBuy(agentUrl, options);
  steps.push(...createSteps);

  if (!mediaBuyId || !profile?.tools.includes('update_media_buy')) {
    return { steps, profile };
  }

  // Find a package ID — try get_media_buys first, fall back to convention
  let packageId = 'pkg-0';

  if (profile.tools.includes('get_media_buys')) {
    const { result: fetchResult, step: fetchStep } = await runStep<TaskResult>(
      'Fetch package IDs',
      'get_media_buys',
      async () =>
        client.executeTask('get_media_buys', {
          media_buy_ids: [mediaBuyId],
        }) as Promise<TaskResult>
    );

    if (fetchResult?.success && fetchResult?.data) {
      const mediaBuys = (fetchResult.data.media_buys || []) as Array<Record<string, unknown>>;
      const mediaBuy =
        mediaBuys.find((item: Record<string, unknown>) => item.media_buy_id === mediaBuyId) || mediaBuys[0];
      const packages = (mediaBuy?.packages || []) as Array<Record<string, unknown>>;
      if (packages[0]?.package_id) {
        packageId = packages[0].package_id as string;
        fetchStep.details = `Found package ${packageId}`;
      } else {
        fetchStep.details = `No packages found, falling back to '${packageId}'`;
      }
    } else if (fetchResult && !fetchResult.success) {
      fetchStep.passed = false;
      fetchStep.error = fetchResult.error || 'get_media_buys failed during package ID discovery';
    }
    steps.push(fetchStep);
  }

  // Step 1: Pause a package
  const { result: pauseResult, step: pauseStep } = await runStep<TaskResult>(
    'Pause package',
    'update_media_buy',
    async () =>
      client.updateMediaBuy({
        media_buy_id: mediaBuyId,
        packages: [{ package_id: packageId, paused: true }],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional: test request bypasses strict typing
      } as any) as Promise<TaskResult>
  );

  if (pauseResult?.success && pauseResult?.data) {
    const data = pauseResult.data as unknown as Record<string, unknown>;
    const affectedPackages = (data.affected_packages || []) as Array<Record<string, unknown>>;
    const pkg = affectedPackages.find(p => p.package_id === packageId) || affectedPackages[0];
    pauseStep.details = `Paused package ${packageId}, paused: ${pkg?.paused}`;
    pauseStep.response_preview = JSON.stringify(
      {
        media_buy_id: mediaBuyId,
        media_buy_status: extractStatus(data),
        package_id: pkg?.package_id,
        package_paused: pkg?.paused,
      },
      null,
      2
    );
  } else if (pauseResult && !pauseResult.success) {
    pauseStep.passed = false;
    pauseStep.error = pauseResult.error || 'Package pause failed';
  }
  steps.push(pauseStep);

  // Step 2: Resume the package
  const { result: resumeResult, step: resumeStep } = await runStep<TaskResult>(
    'Resume package',
    'update_media_buy',
    async () =>
      client.updateMediaBuy({
        media_buy_id: mediaBuyId,
        packages: [{ package_id: packageId, paused: false }],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional: test request bypasses strict typing
      } as any) as Promise<TaskResult>
  );

  if (resumeResult?.success && resumeResult?.data) {
    const data = resumeResult.data as unknown as Record<string, unknown>;
    const affectedPackages = (data.affected_packages || []) as Array<Record<string, unknown>>;
    const pkg = affectedPackages.find(p => p.package_id === packageId) || affectedPackages[0];
    resumeStep.details = `Resumed package ${packageId}, paused: ${pkg?.paused}`;
    resumeStep.response_preview = JSON.stringify(
      {
        media_buy_id: mediaBuyId,
        media_buy_status: extractStatus(data),
        package_id: pkg?.package_id,
        package_paused: pkg?.paused,
      },
      null,
      2
    );
  } else if (resumeResult && !resumeResult.success) {
    resumeStep.passed = false;
    resumeStep.error = resumeResult.error || 'Package resume failed';
  }
  steps.push(resumeStep);

  // Step 3: Verify media buy is still active
  if (profile.tools.includes('get_media_buys')) {
    const { result: verifyResult, step: verifyStep } = await runStep<TaskResult>(
      'Verify media buy still active after package operations',
      'get_media_buys',
      async () =>
        client.executeTask('get_media_buys', {
          media_buy_ids: [mediaBuyId],
        }) as Promise<TaskResult>
    );

    if (verifyResult?.success && verifyResult?.data) {
      const mediaBuys = (verifyResult.data.media_buys || []) as Array<Record<string, unknown>>;
      const mediaBuy =
        mediaBuys.find((item: Record<string, unknown>) => item.media_buy_id === mediaBuyId) || mediaBuys[0];
      const status = mediaBuy?.status as string | undefined;

      if (status === 'active' || status === 'pending_activation') {
        verifyStep.details = `Media buy still ${status} after package-level operations`;
      } else {
        verifyStep.details = `Media buy status is '${status}' — expected 'active' or 'pending_activation'`;
        verifyStep.warnings = [`Package-level pause/resume changed media buy status to '${status}'`];
      }
      verifyStep.response_preview = JSON.stringify(
        { media_buy_id: mediaBuy?.media_buy_id, status },
        null,
        2
      );
    } else if (verifyResult && !verifyResult.success) {
      verifyStep.passed = false;
      verifyStep.error = verifyResult.error || 'get_media_buys verification failed';
    }
    steps.push(verifyStep);
  }

  return { steps, profile };
}
