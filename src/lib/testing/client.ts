/**
 * Test client utilities for AdCP Agent E2E Testing
 */

import { ADCPMultiAgentClient } from '../core/ADCPMultiAgentClient';
import { getBestUnionErrors } from '../utils/union-errors';
import { getFormatAssets, usesDeprecatedAssetsField } from '../utils/format-assets';
import { brandManifestToBrandReference } from '../types/compat';
import type { Product } from '../types/core.generated';
import type {
  GetProductsResponse,
  ListCreativeFormatsResponse,
  Format,
  GetSignalsResponse,
  AccountReference,
  BrandReference,
} from '../types/tools.generated';
import type { TestOptions, TestStepResult, AgentProfile, TaskResult, Logger } from './types';
import { TOOL_RESPONSE_SCHEMAS } from '../utils/response-schemas';
import { parseCapabilitiesResponse } from '../utils/capabilities';

const DEFAULT_BRAND_REF: BrandReference = { domain: 'test.example' };

/**
 * Extract a principal identifier from TestOptions auth.
 * For bearer auth this is the token; for basic auth this is the username.
 */
export function resolveAuthPrincipal(options: TestOptions): string | undefined {
  if (!options.auth) return undefined;
  return options.auth.type === 'basic' ? options.auth.username : options.auth.token;
}

/**
 * Resolve the brand reference to use for a test call.
 * Prefers the new brand field, falls back to converting a legacy brand_manifest.
 */
export function resolveBrand(options: TestOptions): BrandReference {
  return (
    options.brand ||
    (options.brand_manifest && brandManifestToBrandReference(options.brand_manifest)) ||
    DEFAULT_BRAND_REF
  );
}

/**
 * Resolve the account reference to use for a test call.
 * Uses the brand+operator form of AccountReference.
 */
export function resolveAccount(options: TestOptions): AccountReference {
  const brand = resolveBrand(options);
  return {
    brand,
    operator: brand.domain,
    sandbox: options.sandbox,
  };
}

// Default console-based logger
const defaultLogger: Logger = {
  info: (ctx, msg) => console.log(`[INFO] ${msg}`, JSON.stringify(ctx, null, 2)),
  error: (ctx, msg) => console.error(`[ERROR] ${msg}`, JSON.stringify(ctx, null, 2)),
  warn: (ctx, msg) => console.warn(`[WARN] ${msg}`, JSON.stringify(ctx, null, 2)),
  debug: () => {}, // Silent by default
};

// Allow custom logger injection
let logger: Logger = defaultLogger;

/**
 * Set a custom logger for the agent tester
 */
export function setAgentTesterLogger(customLogger: Logger): void {
  logger = customLogger;
}

/**
 * Get current logger instance
 */
export function getLogger(): Logger {
  return logger;
}

/**
 * Create a test client for an agent
 */
export function createTestClient(agentUrl: string, protocol: 'mcp' | 'a2a' = 'mcp', options: TestOptions = {}) {
  const headers: Record<string, string> = {};

  if (options.test_session_id) {
    headers['X-Test-Session-ID'] = options.test_session_id;
  }

  // Build agent config with auth_token if provided
  const agentConfig: {
    id: string;
    name: string;
    agent_uri: string;
    protocol: 'mcp' | 'a2a';
    auth_token?: string;
    headers?: Record<string, string>;
  } = {
    id: 'test',
    name: 'E2E Test Client',
    agent_uri: agentUrl,
    protocol,
  };

  // Add auth to agent config - the library will use it automatically
  if (options.auth) {
    if (options.auth.type === 'basic') {
      // basic: encode credentials here; library sends the Authorization header as-is
      const encoded = Buffer.from(`${options.auth.username}:${options.auth.password}`).toString('base64');
      agentConfig.headers = { Authorization: `Basic ${encoded}` };
    } else {
      // bearer: raw token stored; library prepends 'Bearer ' internally via createMCPAuthHeaders
      agentConfig.auth_token = options.auth.token;
    }
  }

  const multiClient = new ADCPMultiAgentClient([agentConfig], {
    headers,
    validation: { logSchemaViolations: false },
    ...(options.userAgent && { userAgent: options.userAgent }),
  });

  return multiClient.agent('test');
}

export type TestClient = ReturnType<typeof createTestClient>;

/**
 * Return a shared client from options (set by comply()) or create a fresh one.
 * When comply() runs, it creates a single client and passes it via options._client
 * so scenarios reuse the same MCP connection instead of opening 36+ connections.
 */
export function getOrCreateClient(agentUrl: string, options: TestOptions): TestClient {
  return (options._client as TestClient) ?? createTestClient(agentUrl, options.protocol || 'mcp', options);
}

/**
 * Return a pre-discovered profile from options (set by comply()) or discover fresh.
 */
export async function getOrDiscoverProfile(
  client: TestClient,
  options: TestOptions
): Promise<{ profile: AgentProfile; step: TestStepResult }> {
  if (options._profile) {
    return {
      profile: options._profile,
      step: { step: 'Discover agent capabilities', passed: true, duration_ms: 0 },
    };
  }
  return discoverAgentProfile(client);
}

/**
 * Run a single test step with timing
 */
export async function runStep<T>(
  stepName: string,
  taskName: string | undefined,
  fn: () => Promise<T>
): Promise<{ result?: T; step: TestStepResult }> {
  const start = Date.now();
  try {
    const result = await fn();
    const duration = Date.now() - start;
    return {
      result,
      step: {
        step: stepName,
        task: taskName,
        passed: true,
        duration_ms: duration,
      },
    };
  } catch (error) {
    const duration = Date.now() - start;
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      step: {
        step: stepName,
        task: taskName,
        passed: false,
        duration_ms: duration,
        error: errorMessage,
      },
    };
  }
}

/**
 * Discover agent profile - what capabilities does this agent have?
 *
 * When the agent exposes `get_adcp_capabilities`, its response populates
 * `supported_protocols` + `specialisms` on the profile so the compliance
 * runner can select domain and specialism bundles.
 */
export async function discoverAgentProfile(
  client: TestClient
): Promise<{ profile: AgentProfile; step: TestStepResult }> {
  const { result: agentInfo, step } = await runStep('Discover agent capabilities', 'getAgentInfo', () =>
    client.getAgentInfo()
  );

  const profile: AgentProfile = {
    name: agentInfo?.name || 'Unknown',
    tools: agentInfo?.tools?.map((t: { name: string }) => t.name) || [],
  };

  if (agentInfo) {
    step.details = `Agent: ${profile.name}, Tools: ${profile.tools.length}`;
    step.response_preview = JSON.stringify(
      {
        name: profile.name,
        tools: profile.tools,
      },
      null,
      2
    );
  }

  if (profile.tools.includes('get_adcp_capabilities')) {
    try {
      const caps = (await client.getAdcpCapabilities({})) as TaskResult;
      if (caps?.success && caps?.data) {
        const parsed = parseCapabilitiesResponse(caps.data);
        profile.adcp_version = parsed.version;
        profile.supported_protocols = parsed.protocols;
        profile.supports_governance = parsed.protocols.includes('governance');
        profile.supports_si = parsed.protocols.includes('sponsored_intelligence');
        const specialisms = (caps.data as { specialisms?: unknown }).specialisms;
        if (Array.isArray(specialisms)) {
          profile.specialisms = specialisms.filter((s): s is string => typeof s === 'string');
        }
      } else {
        profile.capabilities_probe_error =
          caps?.error || 'get_adcp_capabilities returned no data';
      }
    } catch (err) {
      // Agent advertises the tool but the call failed. Don't silently downgrade —
      // record the failure so the compliance report shows why only universal ran.
      profile.capabilities_probe_error = (err as Error)?.message || String(err);
    }
  }

  return { profile, step };
}

/**
 * Discover what channels, pricing models, formats the agent supports
 * by calling get_products and analyzing the response
 */
export async function discoverAgentCapabilities(
  client: TestClient,
  profile: AgentProfile,
  options: TestOptions
): Promise<{ capabilities: Partial<AgentProfile>; steps: TestStepResult[] }> {
  const steps: TestStepResult[] = [];
  const capabilities: Partial<AgentProfile> = {};

  if (!profile.tools.includes('get_products')) {
    return { capabilities, steps };
  }

  const brief = options.brief || 'Show me all available advertising products across all channels';
  const getProductsParams: Record<string, unknown> = {
    buying_mode: 'brief',
    brief,
    brand: resolveBrand(options),
  };
  const { result, step } = await runStep<TaskResult>(
    'Discover products for capability analysis',
    'get_products',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bypasses strict request typing
    async () => client.getProducts(getProductsParams as any) as Promise<TaskResult>
  );

  if (result?.success && result?.data) {
    const responseData = result.data as GetProductsResponse;
    const products: Product[] = responseData.products ?? [];

    // Extract unique channels
    const channels = new Set<string>();
    const pricingModels = new Set<string>();
    const formatIds = new Set<string>();
    const deliveryTypes = new Set<string>();

    for (const product of products) {
      // Channels from product
      if (product.channels) {
        for (const ch of product.channels) {
          channels.add(ch);
        }
      }
      // Delivery type
      if (product.delivery_type) {
        deliveryTypes.add(product.delivery_type);
      }
      // Pricing models
      if (product.pricing_options) {
        for (const po of product.pricing_options) {
          if (po.pricing_model) pricingModels.add(po.pricing_model);
        }
      }
      // Format IDs
      if (product.format_ids) {
        for (const fid of product.format_ids) {
          const id = typeof fid === 'string' ? fid : fid.id;
          if (id) formatIds.add(id);
        }
      }
    }

    capabilities.channels = Array.from(channels);
    capabilities.pricing_models = Array.from(pricingModels);
    capabilities.format_ids = Array.from(formatIds);
    capabilities.delivery_types = Array.from(deliveryTypes);

    step.details = `Found ${products.length} products across ${channels.size} channel(s), ${pricingModels.size} pricing model(s)`;
    step.response_preview = JSON.stringify(
      {
        products_count: products.length,
        channels: capabilities.channels,
        pricing_models: capabilities.pricing_models,
        delivery_types: capabilities.delivery_types,
        format_count: capabilities.format_ids?.length,
      },
      null,
      2
    );
    step.observation_data = { products_count: products.length, channels: capabilities.channels };
  } else if (result && !result.success) {
    step.passed = false;
    step.error = result.error || 'get_products failed';
  }

  steps.push(step);
  return { capabilities, steps };
}

/**
 * Discover creative formats from a creative agent
 */
export async function discoverCreativeFormats(
  client: TestClient,
  profile: AgentProfile
): Promise<{ formats: AgentProfile['supported_formats']; step: TestStepResult }> {
  const formats: AgentProfile['supported_formats'] = [];

  if (!profile.tools.includes('list_creative_formats')) {
    return {
      formats,
      step: {
        step: 'Discover creative formats',
        passed: false,
        duration_ms: 0,
        error: 'Agent does not support list_creative_formats',
      },
    };
  }

  const { result, step } = await runStep<TaskResult>(
    'Discover creative formats',
    'list_creative_formats',
    async () => client.listCreativeFormats({}) as Promise<TaskResult>
  );

  if (result?.success && result?.data) {
    const responseData = result.data as ListCreativeFormatsResponse;
    const rawFormats: Format[] = responseData.formats ?? [];
    const deprecatedFormats: string[] = [];

    for (const format of rawFormats) {
      const formatInfo: NonNullable<AgentProfile['supported_formats']>[0] = {
        format_id: format.format_id,
        name: format.name,
        required_assets: [],
        optional_assets: [],
      };

      // Check for deprecated assets_required usage
      if (usesDeprecatedAssetsField(format)) {
        const displayId = typeof formatInfo.format_id === 'object' ? formatInfo.format_id.id : formatInfo.format_id;
        deprecatedFormats.push(displayId);
      }

      // Extract asset requirements from format spec using format-assets utilities
      // This handles both v2.6 `assets` and deprecated `assets_required` fields
      const formatAssets = getFormatAssets(format);
      for (const asset of formatAssets) {
        const assetId = asset.item_type === 'individual' ? asset.asset_id : asset.asset_group_id;

        if (asset.required) {
          formatInfo.required_assets?.push(assetId);
        } else {
          formatInfo.optional_assets?.push(assetId);
        }
      }

      formats.push(formatInfo);
    }

    step.details = `Found ${formats.length} format(s)`;
    step.response_preview = JSON.stringify(
      {
        format_count: formats.length,
        sample_formats: formats.slice(0, 3).map(f => ({
          id: f.format_id,
          name: f.name,
          required_assets: f.required_assets?.length || 0,
        })),
      },
      null,
      2
    );

    // Add deprecation warnings if any formats use assets_required
    if (deprecatedFormats.length > 0) {
      step.warnings = [
        `⚠️ DEPRECATION: ${deprecatedFormats.length} format(s) use 'assets_required' field which is deprecated and will be removed in a future version. Please migrate to the 'assets' field instead. (adcp-client 3.6.0+)`,
      ];
      logger.warn(
        { deprecated_formats: deprecatedFormats },
        `Agent uses deprecated 'assets_required' field in ${deprecatedFormats.length} format(s). Migrate to 'assets' field.`
      );
    }
  } else if (result && !result.success) {
    step.passed = false;
    step.error = result.error || 'list_creative_formats failed';
  }

  return { formats, step };
}

/**
 * Discover signals from a signals agent
 */
export async function discoverSignals(
  client: TestClient,
  profile: AgentProfile,
  options: TestOptions
): Promise<{ signals: AgentProfile['supported_signals']; step: TestStepResult; schemaStep?: TestStepResult }> {
  const signals: AgentProfile['supported_signals'] = [];

  if (!profile.tools.includes('get_signals')) {
    return {
      signals,
      step: {
        step: 'Discover signals',
        passed: false,
        duration_ms: 0,
        error: 'Agent does not support get_signals',
      },
    };
  }

  const { result, step } = await runStep<TaskResult>(
    'Discover available signals',
    'get_signals',
    async () =>
      client.getSignals({
        signal_spec: options.brief || 'Show me all available audience signals and segments',
      }) as Promise<TaskResult>
  );

  let schemaStep: TestStepResult | undefined;

  if (result?.success && result?.data) {
    schemaStep = validateResponseSchema('get_signals', result.data);
    const responseData = result.data as GetSignalsResponse;
    const rawSignals = responseData.signals ?? [];

    for (const signal of rawSignals) {
      signals.push({
        signal_id: signal.signal_agent_segment_id,
        name: signal.name,
        type: signal.signal_type,
      });
    }

    step.details = `Found ${signals.length} signal(s)`;
    step.response_preview = JSON.stringify(
      {
        signal_count: signals.length,
        signal_types: [...new Set(signals.map(s => s.type).filter(Boolean))],
        sample_signals: signals.slice(0, 5).map(s => ({
          id: s.signal_id,
          name: s.name,
          type: s.type,
        })),
      },
      null,
      2
    );
  } else if (result && !result.success) {
    step.passed = false;
    step.error = result.error || 'get_signals failed';
  }

  return { signals, step, schemaStep };
}

/**
 * Validate response data against the AdCP Zod schema for a tool.
 * Returns a TestStepResult indicating pass/fail with details on schema violations.
 *
 * For union schemas (success | error responses), Zod's top-level error is the
 * unhelpful "(root): Invalid input". This function detects that case and
 * reports per-variant errors instead, picking the variant with the fewest
 * issues (the closest match) so the developer sees actionable field names.
 */
export function validateResponseSchema(toolName: string, data: unknown): TestStepResult {
  const schema = TOOL_RESPONSE_SCHEMAS[toolName];
  if (!schema) {
    return {
      step: `Schema validation: ${toolName}`,
      passed: true,
      duration_ms: 0,
      details: `No response schema available for ${toolName}`,
      warnings: [`No Zod schema registered for "${toolName}" — validation skipped`],
    };
  }

  const result = schema.safeParse(data);
  if (result.success) {
    return {
      step: `Schema validation: ${toolName}`,
      passed: true,
      duration_ms: 0,
      details: `Response matches ${toolName} schema`,
    };
  }

  let violations = result.error.issues.map(i => {
    const path = i.path.length > 0 ? i.path.join('.') : '(root)';
    return { path, message: i.message, code: i.code };
  });

  // Union schemas produce "(root): Invalid input" when no variant matches.
  // Try each variant individually and report the closest match's errors.
  const first = violations[0];
  const isUnionError = violations.length === 1 && first && first.path === '(root)' && first.code === 'invalid_union';

  if (isUnionError) {
    const betterErrors = getBestUnionErrors(schema, data);
    if (betterErrors && betterErrors.length > 0) {
      violations = betterErrors;
    }
  }

  return {
    step: `Schema validation: ${toolName}`,
    passed: false,
    duration_ms: 0,
    error: `Response schema violations: ${violations.map(v => `${v.path}: ${v.message}`).join('; ')}`,
    response_preview: JSON.stringify({ violations }, null, 2),
  };
}
