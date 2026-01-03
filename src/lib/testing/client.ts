/**
 * Test client utilities for AdCP Agent E2E Testing
 */

import { ADCPMultiAgentClient } from '../core/ADCPMultiAgentClient';
import type { TestOptions, TestStepResult, AgentProfile, TaskResult, Logger } from './types';

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
export function createTestClient(
  agentUrl: string,
  protocol: 'mcp' | 'a2a' = 'mcp',
  options: TestOptions = {}
) {
  const headers: Record<string, string> = {};

  // Dry-run is true by default for safety
  if (options.dry_run !== false) {
    headers['X-Dry-Run'] = 'true';
  }

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
  } = {
    id: 'test',
    name: 'E2E Test Client',
    agent_uri: agentUrl,
    protocol,
  };

  // Add auth_token to agent config - the library will use it automatically
  if (options.auth?.type === 'bearer' && options.auth?.token) {
    agentConfig.auth_token = options.auth.token;
  }

  const multiClient = new ADCPMultiAgentClient([agentConfig], {
    headers,
  });

  return multiClient.agent('test');
}

export type TestClient = ReturnType<typeof createTestClient>;

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
  // Include brand_manifest as some agents require it (e.g., tenant-specific agents)
  const getProductsParams: Record<string, unknown> = {
    brief,
    brand_manifest: options.brand_manifest || {
      name: 'E2E Test Brand',
      url: 'https://test.example.com',
    },
  };
  const { result, step } = await runStep<TaskResult>(
    'Discover products for capability analysis',
    'get_products',
    async () => client.executeTask('get_products', getProductsParams) as Promise<TaskResult>
  );

  if (result?.success && result?.data?.products) {
    const products = result.data.products as any[];

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
          if (po.model) pricingModels.add(po.model);
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

  if (!profile.tools.includes('list_creative_formats') && !profile.tools.includes('list_formats')) {
    return {
      formats,
      step: {
        step: 'Discover creative formats',
        passed: false,
        duration_ms: 0,
        error: 'Agent does not support list_creative_formats or list_formats',
      },
    };
  }

  const toolName = profile.tools.includes('list_creative_formats') ? 'list_creative_formats' : 'list_formats';

  const { result, step } = await runStep<TaskResult>(
    'Discover creative formats',
    toolName,
    async () => client.executeTask(toolName, {}) as Promise<TaskResult>
  );

  if (result?.success && result?.data) {
    const data = result.data as any;
    const rawFormats = data.formats || data.format_ids || [];

    for (const format of rawFormats) {
      const formatInfo: NonNullable<AgentProfile['supported_formats']>[0] = {
        format_id: format.format_id?.id || format.format_id || format.id || 'unknown',
        name: format.name,
        type: format.type,
        required_assets: [],
        optional_assets: [],
      };

      // Extract asset requirements from format spec
      if (format.asset_slots) {
        for (const slot of format.asset_slots) {
          if (slot.required) {
            formatInfo.required_assets?.push(slot.name || slot.id);
          } else {
            formatInfo.optional_assets?.push(slot.name || slot.id);
          }
        }
      }

      formats.push(formatInfo);
    }

    step.details = `Found ${formats.length} format(s)`;
    step.response_preview = JSON.stringify(
      {
        format_count: formats.length,
        format_types: [...new Set(formats.map(f => f.type).filter(Boolean))],
        sample_formats: formats.slice(0, 3).map(f => ({
          id: f.format_id,
          name: f.name,
          required_assets: f.required_assets?.length || 0,
        })),
      },
      null,
      2
    );
  } else if (result && !result.success) {
    step.passed = false;
    step.error = result.error || `${toolName} failed`;
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
): Promise<{ signals: AgentProfile['supported_signals']; step: TestStepResult }> {
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
      client.executeTask('get_signals', {
        brief: options.brief || 'Show me all available audience signals and segments',
      }) as Promise<TaskResult>
  );

  if (result?.success && result?.data) {
    const data = result.data as any;
    const rawSignals = data.signals || [];

    for (const signal of rawSignals) {
      signals.push({
        signal_id: signal.signal_id || signal.id,
        name: signal.name,
        type: signal.type || signal.signal_type,
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

  return { signals, step };
}
