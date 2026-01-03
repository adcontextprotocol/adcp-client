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

import type { TestOptions, TestStepResult, AgentProfile, TaskResult } from '../types';
import {
  createTestClient,
  runStep,
  discoverAgentProfile,
  discoverAgentCapabilities,
} from '../client';
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
  const client = createTestClient(agentUrl, 'mcp', options);

  const { profile, step: profileStep } = await discoverAgentProfile(client);
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
        client.executeTask('create_media_buy', {
          buyer_ref: `error-test-${Date.now()}`,
          brand_manifest: {
            name: 'Error Test Brand',
            url: 'https://test.example.com',
          },
          start_time: new Date(Date.now() + 86400000).toISOString(),
          end_time: new Date(Date.now() + 604800000).toISOString(),
          packages: [
            {
              buyer_ref: 'pkg-error-test',
              product_id: 'NONEXISTENT_PRODUCT_ID_12345',
              budget: 1000,
              pricing_option_id: 'nonexistent-pricing',
            },
          ],
        }) as Promise<TaskResult>
    );

    if (result && !result.success && result.error) {
      step.passed = true;
      step.details = 'Agent correctly returned error for invalid product_id';
      step.response_preview = JSON.stringify({ error: result.error }, null, 2);
    } else if (result?.success) {
      step.passed = false;
      step.error = 'Agent accepted invalid product_id - should have returned error';
    } else {
      step.passed = false;
      step.error = 'Agent returned neither success nor proper error response';
    }
    steps.push(step);
  }

  // Test 2: Missing required field in get_products
  if (profile.tools.includes('get_products')) {
    const { result, step } = await runStep<TaskResult>(
      'Empty request handling',
      'get_products',
      async () => client.executeTask('get_products', {}) as Promise<TaskResult>
    );

    if (result?.success) {
      step.passed = true;
      step.details = 'Agent accepts empty get_products request (permissive)';
    } else if (result && !result.success && result.error) {
      step.passed = true;
      step.details = 'Agent requires brief/brand_manifest (stricter validation)';
      step.response_preview = JSON.stringify({ error: result.error }, null, 2);
    } else {
      step.passed = false;
      step.error = 'Unclear response - neither success nor proper error';
    }
    steps.push(step);
  }

  // Test 3: Invalid format_id in sync_creatives
  if (profile.tools.includes('sync_creatives')) {
    const { result, step } = await runStep<TaskResult>(
      'Invalid format_id error response',
      'sync_creatives',
      async () =>
        client.executeTask('sync_creatives', {
          creatives: [
            {
              creative_id: `invalid-format-test-${Date.now()}`,
              name: 'Invalid Format Test',
              format_id: 'TOTALLY_INVALID_FORMAT_ID_999',
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
        }) as Promise<TaskResult>
    );

    if (result && !result.success && result.error) {
      step.passed = true;
      step.details = 'Agent correctly rejected invalid format_id';
      step.response_preview = JSON.stringify({ error: result.error }, null, 2);
    } else if (result?.success) {
      step.passed = true;
      step.details = 'Agent accepts unknown format_ids (permissive mode)';
    } else {
      step.passed = false;
      step.error = 'Unclear response for invalid format_id';
    }
    steps.push(step);
  }

  // Test 4: get_media_buy_delivery with non-existent media_buy_id
  if (profile.tools.includes('get_media_buy_delivery')) {
    const { result, step } = await runStep<TaskResult>(
      'Non-existent media_buy_id error',
      'get_media_buy_delivery',
      async () =>
        client.executeTask('get_media_buy_delivery', {
          media_buy_ids: ['NONEXISTENT_MEDIA_BUY_ID_99999'],
        }) as Promise<TaskResult>
    );

    if (result && !result.success && result.error) {
      step.passed = true;
      step.details = 'Agent correctly returned error for non-existent media buy';
      step.response_preview = JSON.stringify({ error: result.error }, null, 2);
    } else if (result?.success) {
      const data = result.data as any;
      const deliveries = data?.deliveries || data?.media_buys || [];
      if (deliveries.length === 0) {
        step.passed = true;
        step.details = 'Agent returned empty deliveries for non-existent media buy';
      } else {
        step.passed = false;
        step.error = 'Agent returned deliveries for non-existent media_buy_id';
      }
    } else {
      step.passed = false;
      step.error = 'Unclear response for non-existent media_buy_id';
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
  const client = createTestClient(agentUrl, 'mcp', options);

  const { profile, step: profileStep } = await discoverAgentProfile(client);
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
        client.executeTask('create_media_buy', {
          buyer_ref: `validation-test-${Date.now()}`,
          brand_manifest: { name: 'Validation Test', url: 'https://test.example.com' },
          start_time: new Date(Date.now() + 86400000).toISOString(),
          end_time: new Date(Date.now() + 604800000).toISOString(),
          packages: [
            {
              buyer_ref: 'pkg-validation',
              product_id: 'test-product',
              budget: 1000,
              pricing_option_id: 'test-pricing',
              pacing: 'INVALID_PACING_VALUE' as any,
            },
          ],
        }) as Promise<TaskResult>
    );

    if (result && !result.success && result.error) {
      step.passed = true;
      step.details = 'Agent rejected invalid pacing enum value';
    } else if (result?.success) {
      step.passed = false;
      step.error = 'Agent accepted invalid pacing value - should validate enums';
    } else {
      step.passed = false;
      step.error = 'Unclear validation response';
    }
    steps.push(step);
  }

  // Test 2: Negative budget (definitely invalid)
  if (profile.tools.includes('create_media_buy')) {
    const { result, step } = await runStep<TaskResult>(
      'Negative budget rejection',
      'create_media_buy',
      async () =>
        client.executeTask('create_media_buy', {
          buyer_ref: `negative-budget-test-${Date.now()}`,
          brand_manifest: { name: 'Negative Budget Test', url: 'https://test.example.com' },
          start_time: new Date(Date.now() + 86400000).toISOString(),
          end_time: new Date(Date.now() + 604800000).toISOString(),
          packages: [
            {
              buyer_ref: 'pkg-negative',
              product_id: 'test-product',
              budget: -500,
              pricing_option_id: 'test-pricing',
            },
          ],
        }) as Promise<TaskResult>
    );

    if (result && !result.success && result.error) {
      step.passed = true;
      step.details = 'Agent correctly rejected negative budget';
    } else if (result?.success) {
      step.passed = false;
      step.error = 'CRITICAL: Agent accepted negative budget - must validate minimum: 0';
    } else {
      step.passed = false;
      step.error = 'Unclear response for negative budget';
    }
    steps.push(step);
  }

  // Test 3: Invalid creative weight (> 100)
  if (profile.tools.includes('sync_creatives')) {
    const { result, step } = await runStep<TaskResult>(
      'Invalid creative weight (> 100)',
      'sync_creatives',
      async () =>
        client.executeTask('sync_creatives', {
          creatives: [
            {
              creative_id: `weight-test-${Date.now()}`,
              name: 'Weight Test Creative',
              format_id: 'display_300x250',
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
        }) as Promise<TaskResult>
    );

    if (result && !result.success && result.error) {
      step.passed = true;
      step.details = 'Agent rejected weight > 100';
    } else if (result?.success) {
      step.passed = false;
      step.error = 'Agent accepted weight > 100 - should validate maximum: 100';
    } else {
      step.passed = false;
      step.error = 'Unclear response for invalid weight';
    }
    steps.push(step);
  }

  // Test 4: Empty creatives array
  if (profile.tools.includes('sync_creatives')) {
    const { result, step } = await runStep<TaskResult>(
      'Empty creatives array handling',
      'sync_creatives',
      async () =>
        client.executeTask('sync_creatives', {
          creatives: [],
        }) as Promise<TaskResult>
    );

    if (result && !result.success && result.error) {
      step.passed = true;
      step.details = 'Agent rejected empty creatives array';
    } else if (result?.success) {
      step.passed = true;
      step.details = 'Agent accepts empty creatives array (returns empty result)';
    } else {
      step.passed = false;
      step.error = 'Unclear response for empty creatives array';
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
  const client = createTestClient(agentUrl, 'mcp', options);

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
      client.executeTask('get_products', {
        brief: 'Show all products with pricing details',
        brand_manifest: options.brand_manifest || {
          name: 'Pricing Test',
          url: 'https://test.example.com',
        },
      }) as Promise<TaskResult>
  );

  const products = productsResult?.data?.products as any[] | undefined;
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
  const auctionProducts: any[] = [];
  const fixedProducts: any[] = [];
  const productsWithMinSpend: any[] = [];

  for (const product of products) {
    for (const po of product.pricing_options || []) {
      if (
        po.is_fixed === false ||
        po.floor_price !== undefined ||
        po.price_guidance !== undefined
      ) {
        auctionProducts.push({ product, pricingOption: po });
      } else if (po.rate !== undefined) {
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
    const { product, pricingOption } = auctionProducts[0];
    const { result, step } = await runStep<TaskResult>(
      'Auction pricing without bid_price',
      'create_media_buy',
      async () =>
        client.executeTask('create_media_buy', {
          buyer_ref: `auction-no-bid-${Date.now()}`,
          brand_manifest: { name: 'Auction Test', url: 'https://test.example.com' },
          start_time: new Date(Date.now() + 86400000).toISOString(),
          end_time: new Date(Date.now() + 604800000).toISOString(),
          packages: [
            {
              buyer_ref: 'pkg-auction-no-bid',
              product_id: product.product_id,
              budget: 5000,
              pricing_option_id: pricingOption.pricing_option_id,
            },
          ],
        }) as Promise<TaskResult>
    );

    if (result && !result.success && result.error) {
      step.passed = true;
      step.details = 'Agent correctly requires bid_price for auction pricing';
    } else if (result?.success) {
      step.passed = false;
      step.error = 'Agent accepted auction pricing without bid_price - should require it';
    } else {
      step.passed = false;
      step.error = 'Unclear response for missing bid_price';
    }
    steps.push(step);
  }

  // Test 2: Budget below min_spend_per_package
  if (productsWithMinSpend.length > 0) {
    const { product, pricingOption, minSpend } = productsWithMinSpend[0];
    const underBudget = minSpend * 0.5;

    const { result, step } = await runStep<TaskResult>(
      'Budget below min_spend_per_package',
      'create_media_buy',
      async () =>
        client.executeTask('create_media_buy', {
          buyer_ref: `under-min-spend-${Date.now()}`,
          brand_manifest: { name: 'Min Spend Test', url: 'https://test.example.com' },
          start_time: new Date(Date.now() + 86400000).toISOString(),
          end_time: new Date(Date.now() + 604800000).toISOString(),
          packages: [
            {
              buyer_ref: 'pkg-under-min',
              product_id: product.product_id,
              budget: underBudget,
              pricing_option_id: pricingOption.pricing_option_id,
            },
          ],
        }) as Promise<TaskResult>
    );

    if (result && !result.success && result.error) {
      step.passed = true;
      step.details = `Agent rejected budget ${underBudget} below min_spend ${minSpend}`;
    } else if (result?.success) {
      step.passed = false;
      step.error = `Agent accepted budget ${underBudget} below min_spend ${minSpend}`;
    } else {
      step.passed = false;
      step.error = 'Unclear response for under-min-spend budget';
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
  const client = createTestClient(agentUrl, 'mcp', options);

  const { profile, step: profileStep } = await discoverAgentProfile(client);
  steps.push(profileStep);

  if (!profileStep.passed || !profile.tools.includes('create_media_buy')) {
    return { steps, profile };
  }

  // Test 1: End time before start time
  const { result: endBeforeStart, step: step1 } = await runStep<TaskResult>(
    'End time before start time',
    'create_media_buy',
    async () =>
      client.executeTask('create_media_buy', {
        buyer_ref: `temporal-test-${Date.now()}`,
        brand_manifest: { name: 'Temporal Test', url: 'https://test.example.com' },
        start_time: new Date(Date.now() + 604800000).toISOString(), // 7 days from now
        end_time: new Date(Date.now() + 86400000).toISOString(), // 1 day from now (before start!)
        packages: [
          {
            buyer_ref: 'pkg-temporal',
            product_id: 'test-product',
            budget: 1000,
            pricing_option_id: 'test-pricing',
          },
        ],
      }) as Promise<TaskResult>
  );

  if (endBeforeStart && !endBeforeStart.success && endBeforeStart.error) {
    step1.passed = true;
    step1.details = 'Agent correctly rejected end_time before start_time';
  } else if (endBeforeStart?.success) {
    step1.passed = false;
    step1.error = 'Agent accepted end_time before start_time - must validate';
  } else {
    step1.passed = false;
    step1.error = 'Unclear response for invalid temporal ordering';
  }
  steps.push(step1);

  // Test 2: Start time in the past
  const { result: pastStart, step: step2 } = await runStep<TaskResult>(
    'Start time in the past',
    'create_media_buy',
    async () =>
      client.executeTask('create_media_buy', {
        buyer_ref: `past-start-${Date.now()}`,
        brand_manifest: { name: 'Past Start Test', url: 'https://test.example.com' },
        start_time: new Date(Date.now() - 86400000).toISOString(), // Yesterday
        end_time: new Date(Date.now() + 604800000).toISOString(), // 7 days from now
        packages: [
          {
            buyer_ref: 'pkg-past',
            product_id: 'test-product',
            budget: 1000,
            pricing_option_id: 'test-pricing',
          },
        ],
      }) as Promise<TaskResult>
  );

  if (pastStart && !pastStart.success && pastStart.error) {
    step2.passed = true;
    step2.details = 'Agent rejected start_time in the past';
  } else if (pastStart?.success) {
    step2.passed = true;
    step2.details = 'Agent accepts start_time in past (may auto-adjust)';
  } else {
    step2.passed = false;
    step2.error = 'Unclear response for past start_time';
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
  const client = createTestClient(agentUrl, 'mcp', options);

  const { profile, step: profileStep } = await discoverAgentProfile(client);
  steps.push(profileStep);

  if (!profileStep.passed) {
    return { steps, profile };
  }

  // Test 1: Does get_products require brand_manifest?
  if (profile.tools.includes('get_products')) {
    const { result: withoutManifest, step: step1 } = await runStep<TaskResult>(
      'get_products without brand_manifest',
      'get_products',
      async () =>
        client.executeTask('get_products', {
          brief: 'Show me all available products',
        }) as Promise<TaskResult>
    );

    if (withoutManifest?.success && withoutManifest?.data?.products?.length) {
      step1.details = `Returns ${withoutManifest.data.products.length} products without brand_manifest`;
    } else if (withoutManifest && !withoutManifest.success) {
      step1.details = 'Requires brand_manifest for product discovery';
    }
    steps.push(step1);

    // Test 2: Are results filtered by brief?
    const { result: specificBrief, step: step2 } = await runStep<TaskResult>(
      'get_products with specific brief',
      'get_products',
      async () =>
        client.executeTask('get_products', {
          brief: 'Looking specifically for podcast audio advertising only',
          brand_manifest: options.brand_manifest || {
            name: 'Brief Filter Test',
            url: 'https://test.example.com',
          },
        }) as Promise<TaskResult>
    );

    const { result: broadBrief } = await runStep<TaskResult>(
      'get_products with broad brief',
      'get_products',
      async () =>
        client.executeTask('get_products', {
          brief: 'Show all products across all channels and formats',
          brand_manifest: options.brand_manifest || {
            name: 'Brief Filter Test',
            url: 'https://test.example.com',
          },
        }) as Promise<TaskResult>
    );

    const specificCount = specificBrief?.data?.products?.length || 0;
    const broadCount = broadBrief?.data?.products?.length || 0;

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
  const client = createTestClient(agentUrl, 'mcp', options);

  const { profile, step: profileStep } = await discoverAgentProfile(client);
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
      const data = result.data as any;
      const properties = data.authorized_properties || data.properties || [];
      const publisherDomains = data.publisher_domains || [];
      const issues: string[] = [];

      // Check for undefined elements
      for (let i = 0; i < properties.length; i++) {
        if (properties[i] === undefined || properties[i] === null) {
          issues.push(`properties[${i}] is ${properties[i]}`);
        }
      }
      for (let i = 0; i < publisherDomains.length; i++) {
        if (publisherDomains[i] === undefined || publisherDomains[i] === null) {
          issues.push(`publisher_domains[${i}] is ${publisherDomains[i]}`);
        }
      }

      if (issues.length > 0) {
        step.passed = false;
        step.error = `Schema validation errors: ${issues.slice(0, 3).join(', ')}`;
        step.response_preview = JSON.stringify(
          {
            issues: issues.slice(0, 10),
            properties_count: properties.length,
            publisher_domains_count: publisherDomains.length,
          },
          null,
          2
        );
      } else {
        step.details = `Properties consistent: ${properties.length} properties, ${publisherDomains.length} domains`;
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
      async () => client.executeTask('list_creatives', {}) as Promise<TaskResult>
    );

    if (result?.success && result?.data) {
      const data = result.data as any;
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
