#!/usr/bin/env tsx

import {
  ADCP_VERSION,
  AgentClient,
  CapabilityPreflightError,
  type AgentConfig,
  type CapabilityEvidenceScope,
  type CapabilityEvidenceSnapshot,
  type SingleAgentClientConfig,
  type WebhookHandlerAdapter,
  type WebhookMetadata,
  type WebhookRegistration,
  type WebhookRegistrationStore,
} from '@adcp/sdk';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';

type ListProductsResult = Awaited<ReturnType<AgentClient['listProducts']>>;
const SUBMITTED_POLL_INTERVAL_MS = 60_000;

interface AuthenticatedRequestContext {
  tenantId: string;
  sellerAccountId: string;
  brandDomain: string;
}

interface StoredTaskSnapshot {
  operationId: string;
  serverTaskId?: string;
  status: ListProductsResult['status'];
  recordedAt: string;
}

interface ExistingTransaction {
  recordTask(result: StoredTaskSnapshot): Promise<void>;
}

interface ExistingStore extends WebhookRegistrationStore {
  isAuthorized(ctx: AuthenticatedRequestContext): Promise<boolean>;
  transaction<T>(tenantId: string, work: (tx: ExistingTransaction) => Promise<T>): Promise<T>;
  /** Resolve operationId to its stored tenant, re-authorize, and write idempotently. */
  recordWebhookSettlement(result: StoredWebhookSnapshot): Promise<void>;
}

interface StoredWebhookSnapshot {
  operationId: string;
  serverTaskId: string;
  taskType: string;
  status: WebhookMetadata['status'];
  recordedAt: string;
}

type CapabilityPreflight = (
  client: AgentClient,
  scope: CapabilityEvidenceScope,
  signal: AbortSignal
) => Promise<Omit<CapabilityEvidenceSnapshot, 'scope'>>;

function taskSnapshot(result: ListProductsResult): StoredTaskSnapshot {
  return {
    operationId: result.metadata.taskId,
    serverTaskId: result.metadata.serverTaskId,
    status: result.status,
    recordedAt: result.metadata.timestamp,
  };
}

export class ExistingPlatformAdcp {
  static async create(
    agentConfig: AgentConfig,
    clientOptions: SingleAgentClientConfig,
    store: ExistingStore,
    preflight: CapabilityPreflight,
    signal: AbortSignal
  ): Promise<ExistingPlatformAdcp> {
    try {
      const agent = await AgentClient.createWithCapabilityPreflight(
        agentConfig,
        async ({ client, scope }) => ({ ...(await preflight(client, scope, signal)), scope }),
        clientOptions
      );
      return new ExistingPlatformAdcp(agent, store);
    } catch (error) {
      if (!(error instanceof CapabilityPreflightError)) throw error;
      // Preserve scoped transports and availability: rejected evidence falls
      // back to fresh discovery on a newly constructed client.
      const agent = new AgentClient(agentConfig, clientOptions);
      await agent.getCapabilities({ signal });
      return new ExistingPlatformAdcp(agent, store);
    }
  }

  constructor(
    private readonly agent: AgentClient,
    private readonly store: ExistingStore
  ) {}

  /** Mount with raw body capture on the trusted macro route configured below. */
  createWebhookHandler(adapter: WebhookHandlerAdapter) {
    return this.agent.createWebhookHandler(adapter);
  }

  async reuseCapabilityEvidence(preflight: CapabilityPreflight, signal: AbortSignal) {
    const scope = this.agent.getCapabilityEvidenceScope();
    const observed = await preflight(this.agent, scope, signal);
    // Refusal clears any older cached evidence, so the following read performs
    // fresh, caller-cancellable discovery in the client's own transport scope.
    this.agent.primeCapabilities({ ...observed, scope });
    return this.agent.getCapabilities({ signal });
  }

  async listProducts(ctx: AuthenticatedRequestContext, signal: AbortSignal): Promise<ListProductsResult> {
    if (!(await this.store.isAuthorized(ctx))) throw new Error('Seller account is not authorized for this tenant');
    const initial = await this.agent.listProducts(
      {
        account: { account_id: ctx.sellerAccountId },
        brand: { domain: ctx.brandDomain },
      },
      undefined,
      { signal, timeout: 15_000 }
    );

    // Persist only serializable identifiers/status. The continuation closure is
    // process-local; durable webhook registration is provided by the same store.
    await this.store.transaction(ctx.tenantId, tx => tx.recordTask(taskSnapshot(initial)));

    let settled = initial;
    if (initial.status === 'submitted' && initial.submitted) {
      // Re-check current authorization before starting polling. A stale
      // authenticated request context must not become a durable capability.
      if (!(await this.store.isAuthorized(ctx))) throw new Error('Seller account authorization expired');
      settled = await initial.submitted.waitForCompletion(SUBMITTED_POLL_INTERVAL_MS, signal);
    }
    await this.store.transaction(ctx.tenantId, tx => tx.recordTask(taskSnapshot(settled)));
    return settled;
  }
}

export function createExistingPlatformIntegration(store: ExistingStore): ExistingPlatformAdcp {
  const sellerUrl = process.env['ADCP_SELLER_URL'];
  if (!sellerUrl) throw new Error('ADCP_SELLER_URL is required');
  const webhookUrl = process.env['ADCP_WEBHOOK_URL'];
  const webhookSecret = process.env['ADCP_WEBHOOK_SECRET'];
  if ((webhookUrl && !webhookSecret) || (!webhookUrl && webhookSecret)) {
    throw new Error('ADCP_WEBHOOK_URL and ADCP_WEBHOOK_SECRET must be configured together');
  }
  if (webhookUrl && (!webhookUrl.includes('{task_type}') || !webhookUrl.includes('{operation_id}'))) {
    throw new Error('ADCP_WEBHOOK_URL must contain {task_type} and {operation_id} route macros');
  }
  const agent = new AgentClient(
    {
      id: 'existing-platform-seller',
      name: 'Existing platform seller',
      agent_uri: sellerUrl,
      protocol: 'mcp',
      auth_token: process.env['ADCP_AUTH_TOKEN'],
    },
    {
      adcpVersion: ADCP_VERSION,
      webhookRegistrationStore: store,
      handlers: {
        onTaskStatusChange: async (_response, metadata) => {
          await store.recordWebhookSettlement({
            operationId: metadata.operation_id,
            serverTaskId: metadata.task_id,
            taskType: metadata.task_type,
            status: metadata.status,
            recordedAt: metadata.timestamp,
          });
        },
      },
      ...(webhookUrl && webhookSecret
        ? {
            webhookSecret,
            webhookUrlTemplate: {
              template: webhookUrl,
              tools: ['list_products'],
            },
          }
        : {}),
    }
  );
  return new ExistingPlatformAdcp(agent, store);
}

/** Providerless packed-artifact smoke: official in-process MCP, empty real inventory, durable store double. */
export async function runExistingPlatformSmoke(): Promise<void> {
  const [{ McpServer }, { InMemoryTransport }, { z }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/mcp.js'),
    import('@modelcontextprotocol/sdk/inMemory.js'),
    import('zod'),
  ]);
  const server = new McpServer({ name: 'Existing platform smoke seller', version: '1.0.0' });
  server.registerTool('list_products', { inputSchema: {} }, async () => ({
    content: [{ type: 'text', text: '{}' }],
    structuredContent: { status: 'submitted', task_id: 'local-list-products-1' },
  }));
  server.registerTool(
    'tasks_get',
    { inputSchema: { task_id: z.string(), include_result: z.boolean().optional() } },
    async ({ task_id }) => ({
      content: [{ type: 'text', text: '{}' }],
      structuredContent: {
        task_id,
        task_type: 'list_products',
        protocol: 'media_buy',
        status: 'completed',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:01.000Z',
        completed_at: '2026-01-01T00:00:01.000Z',
        result: { products: [], feed_version: 'local-empty-v1', cache_scope: 'account' },
      },
    })
  );

  class LocalStore implements ExistingStore {
    readonly registrations = new Map<string, Readonly<WebhookRegistration>>();
    readonly statuses: Array<{ status: string }> = [];
    async get(agentId: string, operationId: string) {
      return this.registrations.get(`${agentId}:${operationId}`);
    }
    async putIfAbsent(registration: WebhookRegistration) {
      this.registrations.set(`${registration.agentId}:${registration.operationId}`, structuredClone(registration));
    }
    async isAuthorized() {
      return true;
    }
    async transaction<T>(_tenantId: string, work: (tx: ExistingTransaction) => Promise<T>) {
      return work({ recordTask: async snapshot => void this.statuses.push(structuredClone(snapshot)) });
    }
    async recordWebhookSettlement(result: StoredWebhookSnapshot) {
      this.statuses.push({ status: result.status });
    }
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new McpClient({ name: 'Existing platform smoke buyer', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  try {
    const agent = AgentClient.fromMCPClient(mcpClient, {
      agentId: 'existing-platform-smoke',
      adcpVersion: ADCP_VERSION,
      validation: { requests: 'off', responses: 'off' },
      validateFeatures: false,
    });
    const store = new LocalStore();
    const integration = new ExistingPlatformAdcp(agent, store);
    const signal = AbortSignal.timeout(5_000);
    const capabilities: CapabilityEvidenceSnapshot['capabilities'] = {
      version: 'v3',
      majorVersions: [3],
      supportedVersions: [ADCP_VERSION],
      servedVersion: ADCP_VERSION,
      protocols: ['media_buy'],
      features: {
        inlineCreativeManagement: false,
        propertyListFiltering: false,
        contentStandards: false,
        conversionTracking: false,
        audienceTargeting: false,
      },
      extensions: [],
      _synthetic: false,
    };
    await integration.reuseCapabilityEvidence(
      async () => ({
        capabilities,
        observedAt: new Date(Date.now() - 1_000).toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        toolSchemas: { list_products: { account: {}, brand: {} } },
      }),
      signal
    );
    const result = await integration.listProducts(
      { tenantId: 'tenant-local', sellerAccountId: 'account-local', brandDomain: 'example.com' },
      signal
    );
    if (result.status !== 'completed' || !store.statuses.some(status => status.status === 'submitted')) {
      throw new Error('Providerless smoke did not exercise submitted-to-completed recovery');
    }
  } finally {
    await mcpClient.close();
    await server.close();
  }
}

if (process.env['ADCP_EXAMPLE_CHECK'] === '1') {
  void runExistingPlatformSmoke().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
