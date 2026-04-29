/**
 * Schema Compliance Testing
 *
 * Validates that an agent's responses use correct v3 field names and enum values.
 * Uses GET-only operations — no writes required.
 *
 * Checks:
 * - Channel enum values (hard fail on invalid values)
 * - Pricing field names: fixed_price (not fixed_rate), floor_price top-level
 * - Format assets: assets array with required boolean (not assets_required)
 */

import type { Product } from '../../types/core.generated';
import type { GetProductsResponse, GetSignalsResponse, ListCreativeFormatsResponse, Format } from '../../types/tools.generated';
import type { TestOptions, TestStepResult, AgentProfile, TaskResult } from '../types';
import { getOrCreateClient, runStep, getOrDiscoverProfile, validateResponseSchema } from '../client';

// v3 channel taxonomy — 19 channels
const V3_CHANNELS = new Set([
  'display',
  'olv',
  'social',
  'search',
  'ctv',
  'linear_tv',
  'radio',
  'streaming_audio',
  'podcast',
  'dooh',
  'ooh',
  'print',
  'cinema',
  'email',
  'gaming',
  'retail_media',
  'influencer',
  'affiliate',
  'product_placement',
]);

export async function testSchemaCompliance(
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

  // Path A: no supported discovery tool — skip field-shape checks gracefully
  if (!profile.tools.includes('get_products') && !profile.tools.includes('get_signals')) {
    steps.push({
      step: 'Schema compliance check support',
      passed: true,
      duration_ms: 0,
      details: 'Agent does not advertise get_products or get_signals — discovery field-shape checks skipped',
      warnings: ['Schema compliance: no supported discovery tool (get_products, get_signals) found; checks skipped'],
    });
    // Fall through to list_creative_formats check below
  }

  // Path B: signals agent — validate GetSignalsResponse schema and field semantics
  else if (profile.tools.includes('get_signals') && !profile.tools.includes('get_products')) {
    const { result: signalsResult, step: signalsStep } = await runStep<TaskResult>(
      'Get signals (schema compliance)',
      'get_signals',
      async () =>
        client.getSignals({
          signal_spec: options.brief || 'Schema compliance test — retrieve all available signals',
        }) as Promise<TaskResult>
    );

    if (!signalsResult?.success || !signalsResult?.data) {
      signalsStep.passed = false;
      signalsStep.error = signalsResult?.error || 'get_signals returned no data';
      steps.push(signalsStep);
      return { steps, profile };
    }
    steps.push(signalsStep);

    const signalsData = signalsResult.data as GetSignalsResponse;
    steps.push(validateResponseSchema('get_signals', signalsData));

    const signals = signalsData.signals ?? [];
    if (signals.length === 0) {
      steps.push({
        step: 'Schema compliance: no signals to validate',
        passed: true,
        duration_ms: 0,
        details: 'Agent returned no signals — field-shape checks skipped',
        warnings: ['No signals returned; cannot validate signal_agent_segment_id, name, signal_type fields'],
      });
    } else {
      const missing: string[] = [];
      for (const signal of signals) {
        const raw = signal as unknown as Record<string, unknown>;
        if (!raw.signal_agent_segment_id) missing.push('signal missing signal_agent_segment_id');
        if (!raw.name) missing.push('signal missing name');
        if (!raw.signal_type) missing.push('signal missing signal_type');
      }
      steps.push({
        step: 'Validate signal required fields',
        passed: missing.length === 0,
        duration_ms: 0,
        details:
          missing.length === 0
            ? `All ${signals.length} signal(s) have required fields (signal_agent_segment_id, name, signal_type)`
            : `Required fields missing: ${missing.slice(0, 5).join('; ')}`,
        error: missing.length > 0 ? missing.slice(0, 5).join('; ') : undefined,
      });
    }
    // Fall through to list_creative_formats check below
  }

  // Path C: get_products present — existing product catalog checks
  else {
    const { result: productsResult, step: productsStep } = await runStep<TaskResult>(
      'Get products (schema compliance)',
      'get_products',
      async () =>
        client.getProducts({
          buying_mode: 'brief',
          brief: options.brief || 'Schema compliance test — retrieve all available products',
          brand: options.brand,
        }) as Promise<TaskResult>
    );

    if (!productsResult?.success || !productsResult?.data) {
      productsStep.passed = false;
      productsStep.error = productsResult?.error || 'get_products returned no data';
      steps.push(productsStep);
      return { steps, profile };
    }
    steps.push(productsStep);

    const data = productsResult.data as GetProductsResponse;
    const products: Product[] = data.products || [];

    // --- Zod schema validation (catches missing required fields + invalid enum values) ---
    steps.push(validateResponseSchema('get_products', data));

    if (products.length === 0) {
      steps.push({
        step: 'Schema compliance: no products to validate',
        passed: true,
        duration_ms: 0,
        details: 'Agent returned no products — schema compliance checks skipped',
        warnings: ['No products returned; cannot validate channel, pricing, or format field schemas'],
      });
      return { steps, profile };
    }

    // --- Channel enum validation (hard fail) ---
    const invalidChannels: string[] = [];
    const allChannels = new Set<string>();

    for (const product of products) {
      for (const channel of product.channels || []) {
        allChannels.add(channel);
        if (!V3_CHANNELS.has(channel)) {
          invalidChannels.push(`"${channel}" in product ${product.product_id}`);
        }
      }
    }

    steps.push({
      step: 'Validate channel enum values',
      passed: invalidChannels.length === 0,
      duration_ms: 0,
      details:
        invalidChannels.length === 0
          ? `All ${allChannels.size} channel value(s) are valid v3 channels: ${Array.from(allChannels).join(', ')}`
          : `Invalid channel values detected (not in v3 taxonomy): ${invalidChannels.join('; ')}`,
      error:
        invalidChannels.length > 0
          ? `Channel enum violations: ${invalidChannels.join('; ')}. Valid channels: ${Array.from(V3_CHANNELS).join(', ')}`
          : undefined,
      response_preview: JSON.stringify(
        {
          channels_found: Array.from(allChannels),
          invalid_channels: invalidChannels,
        },
        null,
        2
      ),
    });

    // --- Pricing field name validation (warn, not fail) ---
    const pricingIssues: string[] = [];
    const pricingChecked: string[] = [];
    let fixedPriceFound = false;

    for (const product of products) {
      for (const option of product.pricing_options || []) {
        const optionId = option.pricing_option_id || '(unknown)';
        // Cast to Record for deprecated-field checks — compliance testing intentionally
        // probes fields that may not exist on the generated PricingOption union
        const raw = option as unknown as Record<string, unknown>;

        // Check for deprecated fixed_rate field
        if ('fixed_rate' in raw) {
          pricingIssues.push(`pricing_option ${optionId} uses deprecated "fixed_rate" — should be "fixed_price"`);
        }
        if ('fixed_price' in raw) {
          fixedPriceFound = true;
          pricingChecked.push(optionId);
        }

        // Check for floor_price inside price_guidance (deprecated location)
        const pg = raw.price_guidance as Record<string, unknown> | undefined;
        if (pg && 'floor' in pg) {
          pricingIssues.push(
            `pricing_option ${optionId} has "floor" inside price_guidance — should be top-level "floor_price"`
          );
        }
        if ('floor_price' in raw) {
          pricingChecked.push(`${optionId} (floor_price)`);
        }
      }
    }

    const pricingPassed = pricingIssues.length === 0;
    const pricingDetails =
      pricingIssues.length > 0
        ? `Pricing field issues: ${pricingIssues.join('; ')}`
        : fixedPriceFound
          ? `Pricing fields valid (checked ${pricingChecked.length} option(s))`
          : 'No fixed-price products found to validate (agent may be auction-only — cannot confirm field names)';

    steps.push({
      step: 'Validate pricing field names',
      passed: pricingPassed,
      duration_ms: 0,
      details: pricingDetails,
      error: pricingIssues.length > 0 ? pricingIssues.join('; ') : undefined,
      warnings:
        !fixedPriceFound && pricingIssues.length === 0
          ? [
              'No fixed-price products found. If agent supports fixed pricing, verify it uses "fixed_price" (not "fixed_rate") and "floor_price" at the pricing option level (not inside price_guidance).',
            ]
          : undefined,
      response_preview: JSON.stringify(
        {
          issues: pricingIssues,
          options_checked: pricingChecked,
        },
        null,
        2
      ),
    });
  }

  // --- Format assets structure (optional: list_creative_formats) ---
  // Runs for all agent types that advertise list_creative_formats, regardless of discovery path
  if (profile.tools.includes('list_creative_formats')) {
    const { result: formatsResult, step: formatsStep } = await runStep<TaskResult>(
      'Get creative formats (check assets structure)',
      'list_creative_formats',
      async () => client.listCreativeFormats({}) as Promise<TaskResult>
    );

    if (formatsResult?.success && formatsResult?.data) {
      steps.push(validateResponseSchema('list_creative_formats', formatsResult.data));
      const formatsData = formatsResult.data as ListCreativeFormatsResponse;
      const formats: Format[] = formatsData.formats || [];
      const assetsIssues: string[] = [];
      let formatsChecked = 0;

      for (const format of formats) {
        formatsChecked++;
        const formatIdStr = typeof format.format_id === 'object' ? format.format_id.id : String(format.format_id);
        // Check for deprecated assets_required field
        if ('assets_required' in format) {
          assetsIssues.push(
            `format ${formatIdStr} uses deprecated "assets_required" — should be "assets" array with "required" boolean`
          );
        }
        // Validate assets array structure
        if (Array.isArray(format.assets)) {
          for (const asset of format.assets) {
            if (!('required' in asset)) {
              assetsIssues.push(`format ${formatIdStr} asset missing "required" boolean field`);
            }
          }
        }
      }

      formatsStep.details =
        assetsIssues.length === 0
          ? `Format assets valid across ${formatsChecked} format(s)`
          : `Format asset issues: ${assetsIssues.join('; ')}`;
      formatsStep.passed = assetsIssues.length === 0;
      formatsStep.error = assetsIssues.length > 0 ? assetsIssues.join('; ') : undefined;
    }
    steps.push(formatsStep);
  }

  return { steps, profile };
}
