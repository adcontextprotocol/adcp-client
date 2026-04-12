/**
 * Edge Case Testing Scenarios
 *
 * Tests various edge cases, error handling, and validation:
 * - Error handling (invalid inputs, non-existent IDs)
 * - Schema validation (negative values, invalid enums)
 * - Pricing edge cases (auction vs fixed, min spend, floor prices)
 * - Behavior analysis
 * - Temporal validation
 * - Response consistency
 *
 * These scenarios are designed to find bugs and ensure agents
 * properly handle edge cases according to the AdCP spec.
 */

import type { Product, PricingOption } from '../../types/core.generated';
import type {
  CreateMediaBuyRequest,
  GetProductsRequest,
  SyncCreativesRequest,
  GetMediaBuyDeliveryRequest,
  GetProductsResponse,
  ListCreativesResponse,
} from '../../types/tools.generated';
import type { TestOptions, TestStepResult, AgentProfile, TaskResult } from '../types';
import { getOrCreateClient, runStep, resolveBrand, resolveAccount, getOrDiscoverProfile } from '../client';
import { testDiscovery } from './discovery';

/**
 * Test: Error Handling
 * Verifies the agent returns proper discriminated union error responses
 */
export async function testErrorHandling(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);

  const { profile, step: profileStep } = await getOrDiscoverProfile(client, options);
  steps.push(profileStep);

  if (!profileStep.passed) {
    return { steps, profile };
  }

  // Test 1: Invalid product_id in create_media_buy
  if (profile.tools.includes('create_media_buy')) {
    const { result, step } = await runStep<TaskResult>(
      'Invalid product_id error response',
      'create_media_buy',
      async () =>
        client.createMediaBuy({
          idempotency_key: `error-test-${Date.now()}`,
          brand_manifest: {
            name: 'Error Test Brand',
            url: 'https://test.example',
          },
          start_time: new Date(Date.now() + 86400000).toISOString(),
          end_time: new Date(Date.now() + 604800000).toISOString(),
          packages: [
            {
              product_id: 'NONEXISTENT_PRODUCT_ID_12345',
              budget: 1000,
              pricing_option_id: 'nonexistent-pricing',
            },
          ],
        } as unknown as CreateMediaBuyRequest) as Promise<TaskResult>
    );

    if (result?.success) {
      step.passed = false;
      step.error = 'Agent accepted invalid product_id - should have returned error';
    } else {
      // !result (threw) or result.success === false — both count as rejection
      step.passed = true;
      step.details = `Agent correctly rejected invalid product_id${result?.error ? `: ${result.error}` : ''}`;
      if (result?.error) step.response_preview = JSON.stringify({ error: result.error }, null, 2);
    }
    steps.push(step);
  }

  // Test 2: Missing required field in get_products
  if (profile.tools.includes('get_products')) {
    const { result, step } = await runStep<TaskResult>(
      'Empty request handling',
      'get_products',
      async () => client.getProducts({} as unknown as GetProductsRequest) as Promise<TaskResult>
    );

    if (result?.success) {
      step.passed = true;
      step.details = 'Agent accepts empty get_products request (permissive)';
    } else {
      // !result (threw) or result.success === false — both mean stricter validation
      step.passed = true;
      step.details = `Agent requires brief or brand (stricter validation)${result?.error ? `: ${result.error}` : ''}`;
      if (result?.error) step.response_preview = JSON.stringify({ error: result.error }, null, 2);
    }
    steps.push(step);
  }

  // Test 3: Invalid format_id in sync_creatives
  if (profile.tools.includes('sync_creatives')) {
    const { result, step } = await runStep<TaskResult>(
      'Invalid format_id error response',
      'sync_creatives',
      async () =>
        client.syncCreatives({
          account: resolveAccount(options),
          creatives: [
            {
              creative_id: `invalid-format-test-${Date.now()}`,
              name: 'Invalid Format Test',
              format_id: { id: 'TOTALLY_INVALID_FORMAT_ID_999' },
              assets: {
                primary: {
                  url: 'https://via.placeholder.com/300x250',
                  width: 300,
                  height: 250,
                  format: 'png',
                },
              },
            },
          ],
        } as unknown as SyncCreativesRequest) as Promise<TaskResult>
    );

    if (result?.success) {
      step.passed = true;
      step.details = 'Agent accepts unknown format_ids (permissive mode)';
    } else {
      // !result (threw) or result.success === false — both count as rejection
      step.passed = true;
      step.details = `Agent correctly rejected invalid format_id${result?.error ? `: ${result.error}` : ''}`;
      if (result?.error) step.response_preview = JSON.stringify({ error: result.error }, null, 2);
    }
    steps.push(step);
  }

  // Test 4: get_media_buy_delivery with non-existent media_buy_id
  if (profile.tools.includes('get_media_buy_delivery')) {
    const { result, step } = await runStep<TaskResult>(
      'Non-existent media_buy_id error',
      'get_media_buy_delivery',
      async () =>
        client.getMediaBuyDelivery({
          media_buy_ids: ['NONEXISTENT_MEDIA_BUY_ID_99999'],
        } as unknown as GetMediaBuyDeliveryRequest) as Promise<TaskResult>
    );

    if (result?.success) {
      const data = result.data as unknown as Record<string, unknown> | undefined;
      const deliveries = (data?.deliveries || data?.media_buys || []) as unknown[];
      if (deliveries.length === 0) {
        step.passed = true;
        step.details = 'Agent returned empty deliveries for non-existent media buy';
      } else {
        step.passed = false;
        step.error = 'Agent returned deliveries for non-existent media_buy_id';
      }
    } else {
      // !result (threw) or result.success === false — both count as rejection
      step.passed = true;
      step.details = `Agent correctly returned error for non-existent media buy${result?.error ? `: ${result.error}` : ''}`;
      if (result?.error) step.response_preview = JSON.stringify({ error: result.error }, null, 2);
    }
    steps.push(step);
  }

  return { steps, profile };
}

/**
 * Test: Validation
 * Tests that agents properly validate inputs and reject malformed requests
 */
export async function testValidation(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);

  const { profile, step: profileStep } = await getOrDiscoverProfile(client, options);
  steps.push(profileStep);

  if (!profileStep.passed) {
    return { steps, profile };
  }

  // Test 1: Invalid enum value for pacing
  if (profile.tools.includes('create_media_buy')) {
    const { result, step } = await runStep<TaskResult>(
      'Invalid pacing enum value',
      'create_media_buy',
      async () =>
        client.createMediaBuy({
          idempotency_key: `validation-test-${Date.now()}`,
          brand_manifest: { name: 'Validation Test', url: 'https://test.example' },
          start_time: new Date(Date.now() + 86400000).toISOString(),
          end_time: new Date(Date.now() + 604800000).toISOString(),
          packages: [
            {
              product_id: 'test-product',
              budget: 1000,
              pricing_option_id: 'test-pricing',
              pacing: 'INVALID_PACING_VALUE' as unknown as string,
            },
          ],
        } as unknown as CreateMediaBuyRequest) as Promise<TaskResult>
    );

    if (result?.success) {
      step.passed = false;
      step.error = 'Agent accepted invalid pacing value - should validate enums';
    } else {
      step.passed = true;
      step.details = `Agent rejected invalid pacing enum value${result?.error ? `: ${result.error}` : ''}`;
    }
    steps.push(step);
  }

  // Test 2: Negative budget (definitely invalid)
  if (profile.tools.includes('create_media_buy')) {
    const { result, step } = await runStep<TaskResult>(
      'Negative budget rejection',
      'create_media_buy',
      async () =>
        client.createMediaBuy({
          idempotency_key: `negative-budget-test-${Date.now()}`,
          brand_manifest: { name: 'Negative Budget Test', url: 'https://test.example' },
          start_time: new Date(Date.now() + 86400000).toISOString(),
          end_time: new Date(Date.now() + 604800000).toISOString(),
          packages: [
            {
              product_id: 'test-product',
              budget: -500,
              pricing_option_id: 'test-pricing',
            },
          ],
        } as unknown as CreateMediaBuyRequest) as Promise<TaskResult>
    );

    if (result?.success) {
      step.passed = false;
      step.error = 'CRITICAL: Agent accepted negative budget - must validate minimum: 0';
    } else {
      step.passed = true;
      step.details = `Agent correctly rejected negative budget${result?.error ? `: ${result.error}` : ''}`;
    }
    steps.push(step);
  }

  // Test 3: Invalid creative weight (> 100)
  if (profile.tools.includes('sync_creatives')) {
    const { result, step } = await runStep<TaskResult>(
      'Invalid creative weight (> 100)',
      'sync_creatives',
      async () =>
        client.syncCreatives({
          account: resolveAccount(options),
          creatives: [
            {
              creative_id: `weight-test-${Date.now()}`,
              name: 'Weight Test Creative',
              format_id: { agent_url: 'https://creative.adcontextprotocol.org', id: 'display_300x250' },
              weight: 150,
              assets: {
                primary: {
                  url: 'https://via.placeholder.com/300x250',
                  width: 300,
                  height: 250,
                  format: 'png',
                },
              },
            },
          ],
        } as unknown as SyncCreativesRequest) as Promise<TaskResult>
    );

    if (result?.success) {
      step.passed = false;
      step.error = 'Agent accepted weight > 100 - should validate maximum: 100';
    } else {
      step.passed = true;
      step.details = `Agent rejected weight > 100${result?.error ? `: ${result.error}` : ''}`;
    }
    steps.push(step);
  }

  // Test 4: Empty creatives array
  if (profile.tools.includes('sync_creatives')) {
    const { result, step } = await runStep<TaskResult>(
      'Empty creatives array handling',
      'sync_creatives',
      async () =>
        client.syncCreatives({
          account: resolveAccount(options),
          creatives: [],
        } as unknown as SyncCreativesRequest) as Promise<TaskResult>
    );

    if (result?.success) {
      step.passed = true;
      step.details = 'Agent accepts empty creatives array (returns empty result)';
    } else {
      // !result (threw) or result.success === false — both mean agent rejected
      step.passed = true;
      step.details = `Agent rejected empty creatives array${result?.error ? `: ${result.error}` : ''}`;
    }
    steps.push(step);
  }

  return { steps, profile };
}

/**
 * Test: Pricing Edge Cases
 * Tests auction vs fixed pricing, min spend requirements, bid_price handling
 */
export async function testPricingEdgeCases(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);

  const { steps: discoverySteps, profile } = await testDiscovery(agentUrl, options);
  steps.push(...discoverySteps);

  if (!profile?.tools.includes('create_media_buy') || !profile?.tools.includes('get_products')) {
    steps.push({
      step: 'Pricing edge cases',
      passed: false,
      duration_ms: 0,
      error: 'Agent does not support create_media_buy or get_products',
    });
    return { steps, profile };
  }

  // Get products to find actual pricing options
  const { result: productsResult } = await runStep<TaskResult>(
    'Fetch products for pricing analysis',
    'get_products',
    async () =>
      client.getProducts({
        buying_mode: 'brief',
        brief: 'Show all products with pricing details',
        brand: resolveBrand(options),
      } as unknown as GetProductsRequest) as Promise<TaskResult>
  );

  const productsData = productsResult?.data as GetProductsResponse | undefined;
  const products = productsData?.products;
  if (!products?.length) {
    steps.push({
      step: 'Pricing edge cases',
      passed: false,
      duration_ms: 0,
      error: 'No products available for pricing tests',
    });
    return { steps, profile };
  }

  // Analyze products for auction vs fixed pricing
  const auctionProducts: { product: Product; pricingOption: PricingOption }[] = [];
  const fixedProducts: { product: Product; pricingOption: PricingOption }[] = [];
  const productsWithMinSpend: { product: Product; pricingOption: PricingOption; minSpend: number }[] = [];

  for (const product of products) {
    for (const po of product.pricing_options || []) {
      if (!('fixed_price' in po) && (po.floor_price !== undefined || po.price_guidance !== undefined)) {
        auctionProducts.push({ product, pricingOption: po });
      } else if ('fixed_price' in po) {
        fixedProducts.push({ product, pricingOption: po });
      }
      if (po.min_spend_per_package !== undefined && po.min_spend_per_package > 0) {
        productsWithMinSpend.push({
          product,
          pricingOption: po,
          minSpend: po.min_spend_per_package,
        });
      }
    }
  }

  steps.push({
    step: 'Analyze pricing options',
    passed: true,
    duration_ms: 0,
    details: `Found ${fixedProducts.length} fixed, ${auctionProducts.length} auction, ${productsWithMinSpend.length} with min spend`,
  });

  // Test 1: Auction pricing without bid_price (should fail)
  if (auctionProducts.length > 0) {
    const { product, pricingOption } = auctionProducts[0]!;
    const { result, step } = await runStep<TaskResult>(
      'Auction pricing without bid_price',
      'create_media_buy',
      async () =>
        client.createMediaBuy({
          idempotency_key: `auction-no-bid-${Date.now()}`,
          brand_manifest: { name: 'Auction Test', url: 'https://test.example' },
          start_time: new Date(Date.now() + 86400000).toISOString(),
          end_time: new Date(Date.now() + 604800000).toISOString(),
          packages: [
            {
              product_id: product.product_id,
              budget: 5000,
              pricing_option_id: pricingOption.pricing_option_id,
            },
          ],
        } as unknown as CreateMediaBuyRequest) as Promise<TaskResult>
    );

    if (result?.success) {
      step.passed = false;
      step.error = 'Agent accepted auction pricing without bid_price - should require it';
    } else {
      step.passed = true;
      step.details = `Agent correctly requires bid_price for auction pricing${result?.error ? `: ${result.error}` : ''}`;
    }
    steps.push(step);
  }

  // Test 2: Budget below min_spend_per_package
  if (productsWithMinSpend.length > 0) {
    const { product, pricingOption, minSpend } = productsWithMinSpend[0]!;
    const underBudget = minSpend * 0.5;

    const { result, step } = await runStep<TaskResult>(
      'Budget below min_spend_per_package',
      'create_media_buy',
      async () =>
        client.createMediaBuy({
          idempotency_key: `under-min-spend-${Date.now()}`,
          brand_manifest: { name: 'Min Spend Test', url: 'https://test.example' },
          start_time: new Date(Date.now() + 86400000).toISOString(),
          end_time: new Date(Date.now() + 604800000).toISOString(),
          packages: [
            {
              product_id: product.product_id,
              budget: underBudget,
              pricing_option_id: pricingOption.pricing_option_id,
            },
          ],
        } as unknown as CreateMediaBuyRequest) as Promise<TaskResult>
    );

    if (result?.success) {
      step.passed = false;
      step.error = `Agent accepted budget ${underBudget} below min_spend ${minSpend}`;
    } else {
      step.passed = true;
      step.details = `Agent rejected budget ${underBudget} below min_spend ${minSpend}${result?.error ? `: ${result.error}` : ''}`;
    }
    steps.push(step);
  }

  return { steps, profile };
}

/**
 * Test: Temporal Validation
 * Tests date/time ordering and format validation
 */
export async function testTemporalValidation(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);

  const { profile, step: profileStep } = await getOrDiscoverProfile(client, options);
  steps.push(profileStep);

  if (!profileStep.passed || !profile.tools.includes('create_media_buy')) {
    return { steps, profile };
  }

  // Test 1: End time before start time
  const { result: endBeforeStart, step: step1 } = await runStep<TaskResult>(
    'End time before start time',
    'create_media_buy',
    async () =>
      client.createMediaBuy({
        idempotency_key: `temporal-test-${Date.now()}`,
        brand_manifest: { name: 'Temporal Test', url: 'https://test.example' },
        start_time: new Date(Date.now() + 604800000).toISOString(), // 7 days from now
        end_time: new Date(Date.now() + 86400000).toISOString(), // 1 day from now (before start!)
        packages: [
          {
            product_id: 'test-product',
            budget: 1000,
            pricing_option_id: 'test-pricing',
          },
        ],
      } as unknown as CreateMediaBuyRequest) as Promise<TaskResult>
  );

  if (!endBeforeStart) {
    // runStep caught an exception — agent rejected at transport level, which counts as rejection
    step1.passed = true;
    step1.details = `Agent rejected end_time before start_time (threw error)`;
  } else if (endBeforeStart.success) {
    step1.passed = false;
    step1.error = 'Agent accepted end_time before start_time - must validate';
  } else {
    step1.passed = true;
    step1.details = `Agent correctly rejected end_time before start_time${endBeforeStart.error ? `: ${endBeforeStart.error}` : ''}`;
  }
  steps.push(step1);

  // Test 2: Start time in the past
  const { result: pastStart, step: step2 } = await runStep<TaskResult>(
    'Start time in the past',
    'create_media_buy',
    async () =>
      client.createMediaBuy({
        idempotency_key: `past-start-${Date.now()}`,
        brand_manifest: { name: 'Past Start Test', url: 'https://test.example' },
        start_time: new Date(Date.now() - 86400000).toISOString(), // Yesterday
        end_time: new Date(Date.now() + 604800000).toISOString(), // 7 days from now
        packages: [
          {
            product_id: 'test-product',
            budget: 1000,
            pricing_option_id: 'test-pricing',
          },
        ],
      } as unknown as CreateMediaBuyRequest) as Promise<TaskResult>
  );

  if (!pastStart) {
    // runStep caught an exception — agent rejected at transport level
    step2.passed = true;
    step2.details = 'Agent rejected start_time in the past (threw error)';
  } else if (pastStart.success) {
    step2.passed = true;
    step2.details = 'Agent accepts start_time in past (may auto-adjust)';
  } else {
    step2.passed = true;
    step2.details = `Agent rejected start_time in the past${pastStart.error ? `: ${pastStart.error}` : ''}`;
  }
  steps.push(step2);

  return { steps, profile };
}

/**
 * Test: Behavior Analysis
 * Analyzes agent behavioral characteristics
 */
export async function testBehaviorAnalysis(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);

  const { profile, step: profileStep } = await getOrDiscoverProfile(client, options);
  steps.push(profileStep);

  if (!profileStep.passed) {
    return { steps, profile };
  }

  // Test 1: Does get_products require brand?
  if (profile.tools.includes('get_products')) {
    const { result: withoutBrand, step: step1 } = await runStep<TaskResult>(
      'get_products without brand',
      'get_products',
      async () =>
        client.getProducts({
          buying_mode: 'brief',
          brief: 'Show me all available products',
        } as unknown as GetProductsRequest) as Promise<TaskResult>
    );

    const withoutBrandProducts = (withoutBrand?.data as GetProductsResponse | undefined)?.products;
    if (withoutBrand?.success && withoutBrandProducts?.length) {
      step1.details = `Returns ${withoutBrandProducts.length} products without brand`;
    } else if (withoutBrand && !withoutBrand.success) {
      step1.details = 'Requires brand for product discovery';
    }
    steps.push(step1);

    // Test 2: Are results filtered by brief?
    const { result: specificBrief, step: step2 } = await runStep<TaskResult>(
      'get_products with specific brief',
      'get_products',
      async () =>
        client.getProducts({
          buying_mode: 'brief',
          brief: 'Looking specifically for podcast audio advertising only',
          brand: resolveBrand(options),
        } as unknown as GetProductsRequest) as Promise<TaskResult>
    );

    const { result: broadBrief } = await runStep<TaskResult>(
      'get_products with broad brief',
      'get_products',
      async () =>
        client.getProducts({
          buying_mode: 'brief',
          brief: 'Show all products across all channels and formats',
          brand: resolveBrand(options),
        } as unknown as GetProductsRequest) as Promise<TaskResult>
    );

    const specificProducts = (specificBrief?.data as GetProductsResponse | undefined)?.products;
    const broadProducts = (broadBrief?.data as GetProductsResponse | undefined)?.products;
    const specificCount = specificProducts?.length || 0;
    const broadCount = broadProducts?.length || 0;

    if (specificCount < broadCount) {
      step2.passed = true;
      step2.details = `Brief filtering: specific=${specificCount}, broad=${broadCount} (filtered)`;
    } else if (specificCount === broadCount && broadCount > 0) {
      step2.passed = true;
      step2.details = `No brief filtering: specific=${specificCount}, broad=${broadCount} (same)`;
    } else {
      step2.details = `Brief filtering unclear: specific=${specificCount}, broad=${broadCount}`;
    }
    steps.push(step2);
  }

  return { steps, profile };
}

/**
 * Test: Response Consistency
 * Checks for schema errors, pagination bugs, data mismatches
 */
export async function testResponseConsistency(
  agentUrl: string,
  options: TestOptions
): Promise<{ steps: TestStepResult[]; profile?: AgentProfile }> {
  const steps: TestStepResult[] = [];
  const client = getOrCreateClient(agentUrl, options);

  const { profile, step: profileStep } = await getOrDiscoverProfile(client, options);
  steps.push(profileStep);

  if (!profileStep.passed) {
    return { steps, profile };
  }

  // Test list_authorized_properties consistency
  if (profile.tools.includes('list_authorized_properties')) {
    const { result, step } = await runStep<TaskResult>(
      'Check list_authorized_properties consistency',
      'list_authorized_properties',
      async () => client.executeTask('list_authorized_properties', {}) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as unknown as Record<string, unknown>;
      const publisherDomains = (data.publisher_domains || []) as unknown[];
      const issues: string[] = [];

      // Check for undefined elements
      for (let i = 0; i < publisherDomains.length; i++) {
        if (publisherDomains[i] === undefined || publisherDomains[i] === null) {
          issues.push(`publisher_domains[${i}] is ${String(publisherDomains[i])}`);
        }
      }

      if (issues.length > 0) {
        step.passed = false;
        step.error = `Schema validation errors: ${issues.slice(0, 3).join(', ')}`;
        step.response_preview = JSON.stringify(
          {
            issues: issues.slice(0, 10),
            publisher_domains_count: publisherDomains.length,
          },
          null,
          2
        );
      } else {
        step.details = `Publisher domains consistent: ${publisherDomains.length} domain(s)`;
      }
    } else if (result && !result.success) {
      step.passed = false;
      step.error = result.error || 'list_authorized_properties failed';
    }
    steps.push(step);
  }

  // Test list_creatives pagination consistency
  if (profile.tools.includes('list_creatives')) {
    const { result, step } = await runStep<TaskResult>(
      'Check list_creatives pagination consistency',
      'list_creatives',
      async () => client.listCreatives({}) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as ListCreativesResponse;
      const creatives = data.creatives || [];
      const querySummary = data.query_summary;
      const totalMatching = querySummary?.total_matching;
      const returned = querySummary?.returned ?? creatives.length;

      if (totalMatching !== undefined && totalMatching > 0 && returned === 0) {
        step.passed = false;
        step.error = `Pagination bug: total_matching=${totalMatching} but returned=${returned}`;
      } else if (returned !== creatives.length) {
        step.passed = false;
        step.error = `Mismatch: returned=${returned} but creatives.length=${creatives.length}`;
      } else {
        step.details = `Pagination consistent: ${creatives.length} creatives`;
      }
    }
    steps.push(step);
  }

  return { steps, profile };
}
