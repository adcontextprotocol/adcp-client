/**
 * Media Buy Testing Scenarios
 *
 * Tests sales agent media buy capabilities including:
 * - create_media_buy
 * - update_media_buy
 * - get_media_buy_delivery
 * - sync_creatives
 */

import type { TestOptions, TestStepResult, AgentProfile, TaskResult } from '../types';
import { createTestClient, runStep, discoverAgentProfile, discoverAgentCapabilities, resolveBrand } from '../client';
import { testDiscovery } from './discovery';

/**
 * Find a suitable product for testing based on options
 */
export function selectProduct(products: any[], options: TestOptions): any | null {
  // If channels specified, filter to matching products
  let candidates = products;

  if (options.channels?.length) {
    candidates = products.filter(p => p.channels?.some((ch: string) => options.channels!.includes(ch)));
  }

  // If pricing models specified, filter further
  if (options.pricing_models?.length) {
    candidates = candidates.filter(p =>
      p.pricing_options?.some((po: any) => options.pricing_models!.includes(po.model))
    );
  }

  // Return first matching or first product
  return candidates[0] || products[0] || null;
}

/**
 * Select a pricing option from a product
 */
export function selectPricingOption(product: any, preferredModels?: string[]): any | null {
  const options = product.pricing_options || [];

  if (preferredModels?.length) {
    const preferred = options.find((po: any) => preferredModels.includes(po.model));
    if (preferred) return preferred;
  }

  return options[0] || null;
}

/**
 * Build a create_media_buy request
 */
export function buildCreateMediaBuyRequest(
  product: any,
  pricingOption: any,
  options: TestOptions,
  extras: {
    inline_creatives?: any[];
    creative_ids?: string[];
  } = {}
): any {
  const budget = options.budget || 1000;
  const now = new Date();
  const startTime = new Date(now.getTime() + 24 * 60 * 60 * 1000); // Tomorrow
  const endTime = new Date(startTime.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days later

  const isAuction =
    pricingOption.model === 'auction' || pricingOption.is_fixed === false || pricingOption.floor_price !== undefined;

  const packageRequest: any = {
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
    brand: resolveBrand(options),
    start_time: startTime.toISOString(),
    end_time: endTime.toISOString(),
    packages: [packageRequest],
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
      client.executeTask('get_products', {
        brief: options.brief || 'Looking for display advertising products',
        brand: resolveBrand(options),
      }) as Promise<TaskResult>
  );

  const products = productsResult?.data?.products as any[] | undefined;
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
    async () => client.executeTask('create_media_buy', createRequest) as Promise<TaskResult>
  );

  let mediaBuyId: string | undefined;

  if (createResult?.success && createResult?.data) {
    const mediaBuy = createResult.data as any;
    mediaBuyId = mediaBuy.media_buy_id || mediaBuy.media_buy?.media_buy_id;
    const status = mediaBuy.status || mediaBuy.media_buy?.status;
    const packages = mediaBuy.packages || mediaBuy.media_buy?.packages;
    createStep.details = `Created media buy: ${mediaBuyId}, status: ${status}`;
    createStep.created_id = mediaBuyId;
    createStep.response_preview = JSON.stringify(
      {
        media_buy_id: mediaBuyId,
        status,
        packages_count: packages?.length,
        pricing_model: pricingOption.model,
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
        client.executeTask('update_media_buy', {
          media_buy_id: mediaBuyId,
          packages: [
            {
              package_id: 'pkg-0',
              budget: (options.budget || 1000) * 1.5,
            },
          ],
        }) as Promise<TaskResult>
    );

    if (updateResult?.success && updateResult?.data) {
      const data = updateResult.data as any;
      const status = data.status || data.media_buy?.status;
      updateStep.details = `Updated media buy, status: ${status}`;
      updateStep.response_preview = JSON.stringify(
        {
          media_buy_id: data.media_buy_id || data.media_buy?.media_buy_id,
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

  // Test get_media_buy_delivery if available
  if (profile?.tools.includes('get_media_buy_delivery')) {
    const { result: deliveryResult, step: deliveryStep } = await runStep<TaskResult>(
      'Get delivery metrics',
      'get_media_buy_delivery',
      async () =>
        client.executeTask('get_media_buy_delivery', {
          media_buy_ids: [mediaBuyId],
        }) as Promise<TaskResult>
    );

    if (deliveryResult?.success && deliveryResult?.data) {
      const delivery = deliveryResult.data as any;
      deliveryStep.details = `Retrieved delivery metrics`;
      deliveryStep.response_preview = JSON.stringify(
        {
          has_deliveries: !!(delivery.deliveries?.length || delivery.media_buys?.length),
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
  let formatId = 'display_300x250'; // Default
  if (profile.tools.includes('list_creative_formats')) {
    const { result: formatsResult } = await runStep<TaskResult>(
      'Get formats for creative',
      'list_creative_formats',
      async () => client.executeTask('list_creative_formats', {}) as Promise<TaskResult>
    );

    if (formatsResult?.success && formatsResult?.data) {
      const data = formatsResult.data as any;
      const firstFormat = data.format_ids?.[0] || data.formats?.[0];
      if (firstFormat) {
        formatId = typeof firstFormat === 'string' ? firstFormat : firstFormat.id || firstFormat.format_id;
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
      client.executeTask('sync_creatives', {
        creatives: [testCreative],
      }) as Promise<TaskResult>
  );

  if (syncResult?.success && syncResult?.data) {
    const data = syncResult.data as any;
    const creatives = data.creatives || [];
    const actions = creatives.map((c: any) => c.action);
    syncStep.details = `Synced ${creatives.length} creative(s), actions: ${actions.join(', ')}`;
    syncStep.response_preview = JSON.stringify(
      {
        creatives_count: creatives.length,
        actions: actions,
        creative_ids: creatives.map((c: any) => c.creative_id),
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
      async () => client.executeTask('list_creatives', {}) as Promise<TaskResult>
    );

    if (listResult?.success && listResult?.data) {
      const data = listResult.data as any;
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
            statuses: Array.from(new Set(creatives.map((c: any) => c.status))),
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

  // Get products
  const { result: productsResult } = await runStep<TaskResult>(
    'Fetch products for inline creative test',
    'get_products',
    async () =>
      client.executeTask('get_products', {
        brief: options.brief || 'Looking for display advertising products',
        brand: resolveBrand(options),
      }) as Promise<TaskResult>
  );

  const products = productsResult?.data?.products as any[] | undefined;
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

  // Get format for inline creative
  let formatId = 'display_300x250';
  if (product.format_ids?.length) {
    const fid = product.format_ids[0];
    formatId = typeof fid === 'string' ? fid : fid.id || fid.format_id || formatId;
  }

  // Build inline creative
  const inlineCreative = {
    name: `Inline Test Creative ${Date.now()}`,
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

  const createRequest = buildCreateMediaBuyRequest(product, pricingOption, options, {
    inline_creatives: [inlineCreative],
  });

  const { result: createResult, step: createStep } = await runStep<TaskResult>(
    'Create media buy with inline creative',
    'create_media_buy',
    async () => client.executeTask('create_media_buy', createRequest) as Promise<TaskResult>
  );

  if (createResult?.success && createResult?.data) {
    const mediaBuy = createResult.data as any;
    const mediaBuyId = mediaBuy.media_buy_id || mediaBuy.media_buy?.media_buy_id;
    const status = mediaBuy.status || mediaBuy.media_buy?.status;
    const packages = mediaBuy.packages || mediaBuy.media_buy?.packages;
    const hasCreatives = packages?.some((p: any) => p.creatives?.length || p.creative_ids?.length);

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
