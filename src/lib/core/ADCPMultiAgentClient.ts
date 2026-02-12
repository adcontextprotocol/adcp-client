// Multi-agent orchestrator providing simple, intuitive API

import type { AgentConfig } from '../types';
import { AgentClient } from './AgentClient';
import type { SingleAgentClientConfig } from './SingleAgentClient';
import { ConfigurationManager } from './ConfigurationManager';
import { CreativeAgentClient, STANDARD_CREATIVE_AGENTS } from './CreativeAgentClient';
import type { CreativeFormat } from './CreativeAgentClient';
import type { InputHandler, TaskOptions, TaskResult, TaskInfo } from './ConversationTypes';
import type {
  GetProductsRequest,
  GetProductsResponse,
  ListCreativeFormatsRequest,
  ListCreativeFormatsResponse,
  CreateMediaBuyRequest,
  CreateMediaBuyResponse,
  UpdateMediaBuyRequest,
  UpdateMediaBuyResponse,
  SyncCreativesRequest,
  SyncCreativesResponse,
  ListCreativesRequest,
  ListCreativesResponse,
  GetMediaBuyDeliveryRequest,
  GetMediaBuyDeliveryResponse,
  ProvidePerformanceFeedbackRequest,
  ProvidePerformanceFeedbackResponse,
  GetSignalsRequest,
  GetSignalsResponse,
  ActivateSignalRequest,
  ActivateSignalResponse,
} from '../types/tools.generated';

/**
 * Collection of agent clients for parallel operations across multiple AdCP agents.
 *
 * Provides methods to execute AdCP operations (get_products, create_media_buy, etc.)
 * across multiple agents simultaneously using Promise.all().
 *
 * @example
 * ```typescript
 * const collection = new AgentCollection([
 *   { id: 'agent1', agent_uri: 'https://agent1.com', protocol: 'a2a' },
 *   { id: 'agent2', agent_uri: 'https://agent2.com/mcp/', protocol: 'mcp' }
 * ]);
 *
 * // Execute getProducts across all agents
 * const results = await collection.getProducts({ brief: 'Coffee brands' });
 * results.forEach((result, i) => {
 *   console.log(`Agent ${i}: ${result.status}`);
 * });
 * ```
 *
 * @public
 */
export class AgentCollection {
  private clients: Map<string, AgentClient> = new Map();

  constructor(
    private agents: AgentConfig[],
    private config: SingleAgentClientConfig = {}
  ) {
    for (const agent of agents) {
      this.clients.set(agent.id, new AgentClient(agent, config));
    }
  }

  private async executeAllSettled<T>(
    operation: (client: AgentClient) => Promise<TaskResult<T>>
  ): Promise<TaskResult<T>[]> {
    const clients = Array.from(this.clients.values());
    const results = await Promise.allSettled(clients.map(client => operation(client)));

    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      const client = clients[index];
      return {
        success: false,
        status: 'completed' as const,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        metadata: {
          taskId: '',
          taskName: '',
          agent: client.getAgent(),
          responseTimeMs: 0,
          timestamp: new Date().toISOString(),
          clarificationRounds: 0,
          status: 'failed' as const,
        },
      };
    });
  }

  // ====== PARALLEL TASK EXECUTION ======

  /**
   * Execute getProducts on all agents in parallel
   */
  async getProducts(
    params: GetProductsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<GetProductsResponse>[]> {
    return this.executeAllSettled(client => client.getProducts(params, inputHandler, options));
  }

  /**
   * Execute listCreativeFormats on all agents in parallel
   */
  async listCreativeFormats(
    params: ListCreativeFormatsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ListCreativeFormatsResponse>[]> {
    return this.executeAllSettled(client => client.listCreativeFormats(params, inputHandler, options));
  }

  /**
   * Execute createMediaBuy on all agents in parallel
   * Note: This might not make sense for all use cases, but provided for completeness
   */
  async createMediaBuy(
    params: CreateMediaBuyRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<CreateMediaBuyResponse>[]> {
    return this.executeAllSettled(client => client.createMediaBuy(params, inputHandler, options));
  }

  /**
   * Execute updateMediaBuy on all agents in parallel
   */
  async updateMediaBuy(
    params: UpdateMediaBuyRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<UpdateMediaBuyResponse>[]> {
    return this.executeAllSettled(client => client.updateMediaBuy(params, inputHandler, options));
  }

  /**
   * Execute syncCreatives on all agents in parallel
   */
  async syncCreatives(
    params: SyncCreativesRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<SyncCreativesResponse>[]> {
    return this.executeAllSettled(client => client.syncCreatives(params, inputHandler, options));
  }

  /**
   * Execute listCreatives on all agents in parallel
   */
  async listCreatives(
    params: ListCreativesRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ListCreativesResponse>[]> {
    return this.executeAllSettled(client => client.listCreatives(params, inputHandler, options));
  }

  /**
   * Execute getMediaBuyDelivery on all agents in parallel
   */
  async getMediaBuyDelivery(
    params: GetMediaBuyDeliveryRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<GetMediaBuyDeliveryResponse>[]> {
    return this.executeAllSettled(client => client.getMediaBuyDelivery(params, inputHandler, options));
  }

  /**
   * Execute providePerformanceFeedback on all agents in parallel
   */
  async providePerformanceFeedback(
    params: ProvidePerformanceFeedbackRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ProvidePerformanceFeedbackResponse>[]> {
    return this.executeAllSettled(client => client.providePerformanceFeedback(params, inputHandler, options));
  }

  /**
   * Execute getSignals on all agents in parallel
   */
  async getSignals(
    params: GetSignalsRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<GetSignalsResponse>[]> {
    return this.executeAllSettled(client => client.getSignals(params, inputHandler, options));
  }

  /**
   * Execute activateSignal on all agents in parallel
   */
  async activateSignal(
    params: ActivateSignalRequest,
    inputHandler?: InputHandler,
    options?: TaskOptions
  ): Promise<TaskResult<ActivateSignalResponse>[]> {
    return this.executeAllSettled(client => client.activateSignal(params, inputHandler, options));
  }

  // ====== COLLECTION UTILITIES ======

  /**
   * Get individual agent client
   */
  getAgent(agentId: string): AgentClient {
    const client = this.clients.get(agentId);
    if (!client) {
      throw new Error(
        `Agent '${agentId}' not found in collection. Available: ${Array.from(this.clients.keys()).join(', ')}`
      );
    }
    return client;
  }

  /**
   * Get all agent clients
   */
  getAllAgents(): AgentClient[] {
    return Array.from(this.clients.values());
  }

  /**
   * Get agent IDs
   */
  getAgentIds(): string[] {
    return Array.from(this.clients.keys());
  }

  /**
   * Get agent count
   */
  get count(): number {
    return this.clients.size;
  }

  /**
   * Filter agents by a condition
   */
  filter(predicate: (agent: AgentClient) => boolean): AgentClient[] {
    return Array.from(this.clients.values()).filter(predicate);
  }

  /**
   * Map over all agents
   */
  map<T>(mapper: (agent: AgentClient) => T): T[] {
    return Array.from(this.clients.values()).map(mapper);
  }

  /**
   * Execute a custom function on all agents in parallel.
   * Returns PromiseSettledResult array so callers can handle partial failures.
   */
  async execute<T>(executor: (agent: AgentClient) => Promise<T>): Promise<PromiseSettledResult<T>[]> {
    const promises = Array.from(this.clients.values()).map(executor);
    return Promise.allSettled(promises);
  }
}

/**
 * Main multi-agent AdCP client providing unified access to multiple advertising protocol agents.
 *
 * This is the **primary entry point** for the @adcp/client library. It provides flexible
 * access patterns for working with one or multiple AdCP agents (MCP or A2A protocols).
 *
 * ## Key Features
 *
 * - **Single agent access** via `agent(id)` - for individual operations
 * - **Multi-agent access** via `agents([ids])` - for parallel execution across specific agents
 * - **Broadcast access** via `allAgents()` - for parallel execution across all configured agents
 * - **Auto-configuration** via static factory methods (`fromConfig()`, `fromEnv()`, `fromFile()`)
 * - **Full type safety** - all AdCP request/response types are strongly typed
 * - **Protocol agnostic** - works seamlessly with both MCP and A2A agents
 *
 * ## Basic Usage
 *
 * @example Single agent operation
 * ```typescript
 * const client = new ADCPMultiAgentClient([
 *   { id: 'agent1', agent_uri: 'https://agent1.com', protocol: 'mcp' },
 *   { id: 'agent2', agent_uri: 'https://agent2.com', protocol: 'a2a' }
 * ]);
 *
 * // Execute operation on single agent
 * const result = await client.agent('agent1').getProducts({
 *   brief: 'Coffee brands for premium audience'
 * });
 *
 * if (result.status === 'completed') {
 *   console.log('Products:', result.data.products);
 * }
 * ```
 *
 * @example Multi-agent parallel execution
 * ```typescript
 * // Execute across specific agents
 * const results = await client.agents(['agent1', 'agent2']).getProducts({
 *   brief: 'Coffee brands'
 * });
 *
 * // Execute across all agents
 * const allResults = await client.allAgents().getProducts({
 *   brief: 'Coffee brands'
 * });
 *
 * // Process results from all agents
 * allResults.forEach((result, i) => {
 *   console.log(`Agent ${client.agentIds[i]}: ${result.status}`);
 *   if (result.status === 'completed') {
 *     console.log(`  Products: ${result.data.products.length}`);
 *   }
 * });
 * ```
 *
 * @example Auto-configuration from environment
 * ```typescript
 * // Load agents from environment variables or config files
 * const client = ADCPMultiAgentClient.fromConfig();
 *
 * // Or from environment only
 * const client = ADCPMultiAgentClient.fromEnv();
 *
 * // Or from specific file
 * const client = ADCPMultiAgentClient.fromFile('./my-agents.json');
 * ```
 *
 * ## Available Operations
 *
 * All standard AdCP operations are available:
 * - `getProducts()` - Discover advertising products
 * - `listCreativeFormats()` - Get supported creative formats
 * - `createMediaBuy()` - Create new media buy
 * - `updateMediaBuy()` - Update existing media buy
 * - `syncCreatives()` - Upload/sync creative assets
 * - `listCreatives()` - List creative assets
 * - `getMediaBuyDelivery()` - Get delivery performance
 * - `getSignals()` - Get audience signals
 * - `activateSignal()` - Activate audience signals
 * - `providePerformanceFeedback()` - Send performance feedback
 *
 * @see {@link AgentClient} for single-agent operations
 * @see {@link AgentCollection} for multi-agent parallel operations
 * @see {@link SingleAgentClientConfig} for configuration options
 *
 * @public
 */
export class ADCPMultiAgentClient {
  private agentClients: Map<string, AgentClient> = new Map();

  constructor(
    agentConfigs: AgentConfig[] = [],
    private config: SingleAgentClientConfig = {}
  ) {
    for (const agentConfig of agentConfigs) {
      this.agentClients.set(agentConfig.id, new AgentClient(agentConfig, config));
    }
  }

  // ====== FACTORY METHODS FOR EASY SETUP ======

  /**
   * Create client by auto-discovering agent configuration
   *
   * Automatically loads agents from:
   * 1. Environment variables (SALES_AGENTS_CONFIG, ADCP_AGENTS_CONFIG, etc.)
   * 2. Config files (adcp.config.json, adcp.json, .adcp.json, agents.json)
   *
   * @param config - Optional client configuration
   * @returns ADCPMultiAgentClient instance with discovered agents
   *
   * @example
   * ```typescript
   * // Simplest possible setup - auto-discovers configuration
   * const client = ADCPMultiAgentClient.fromConfig();
   *
   * // Use with options
   * const client = ADCPMultiAgentClient.fromConfig({
   *   debug: true,
   *   defaultTimeout: 60000
   * });
   * ```
   */
  static fromConfig(config?: SingleAgentClientConfig): ADCPMultiAgentClient {
    const agents = ConfigurationManager.loadAgents();

    if (agents.length === 0) {
      console.log('\n' + ConfigurationManager.getConfigurationHelp());
      throw new Error('No ADCP agents configured. See configuration help above.');
    }

    // Validate configuration
    ConfigurationManager.validateAgentsConfig(agents);

    return new ADCPMultiAgentClient(agents, config);
  }

  /**
   * Create client from environment variables only
   *
   * @param config - Optional client configuration
   * @returns ADCPMultiAgentClient instance with environment-loaded agents
   *
   * @example
   * ```typescript
   * // Load agents from SALES_AGENTS_CONFIG environment variable
   * const client = ADCPMultiAgentClient.fromEnv();
   * ```
   */
  static fromEnv(config?: SingleAgentClientConfig): ADCPMultiAgentClient {
    const agents = ConfigurationManager.loadAgentsFromEnv();

    if (agents.length === 0) {
      const envVars = ConfigurationManager.getEnvVars();
      throw new Error(`No agents found in environment variables. ` + `Please set one of: ${envVars.join(', ')}`);
    }

    ConfigurationManager.validateAgentsConfig(agents);
    return new ADCPMultiAgentClient(agents, config);
  }

  /**
   * Create client from a specific config file
   *
   * @param configPath - Path to configuration file
   * @param config - Optional client configuration
   * @returns ADCPMultiAgentClient instance with file-loaded agents
   *
   * @example
   * ```typescript
   * // Load from specific file
   * const client = ADCPMultiAgentClient.fromFile('./my-agents.json');
   *
   * // Load from default locations
   * const client = ADCPMultiAgentClient.fromFile();
   * ```
   */
  static fromFile(configPath?: string, config?: SingleAgentClientConfig): ADCPMultiAgentClient {
    const agents = ConfigurationManager.loadAgentsFromConfig(configPath);

    if (agents.length === 0) {
      const searchPaths = configPath ? [configPath] : ConfigurationManager.getConfigPaths();
      throw new Error(`No agents found in config file(s). Searched: ${searchPaths.join(', ')}`);
    }

    ConfigurationManager.validateAgentsConfig(agents);
    return new ADCPMultiAgentClient(agents, config);
  }

  /**
   * Create a simple client with minimal configuration
   *
   * @param agentUrl - Single agent URL
   * @param options - Optional agent and client configuration
   * @returns ADCPMultiAgentClient instance with single agent
   *
   * @example
   * ```typescript
   * // Simplest possible setup for single agent
   * const client = ADCPMultiAgentClient.simple('https://my-agent.example.com');
   *
   * // With options
   * const client = ADCPMultiAgentClient.simple('https://my-agent.example.com', {
   *   agentName: 'My Agent',
   *   protocol: 'mcp',
   *   authToken: 'my-token',
   *   debug: true
   * });
   * ```
   */
  static simple(
    agentUrl: string,
    options: {
      agentId?: string;
      agentName?: string;
      protocol?: 'mcp' | 'a2a';
      authToken?: string;
      debug?: boolean;
      timeout?: number;
    } = {}
  ): ADCPMultiAgentClient {
    const {
      agentId = 'default-agent',
      agentName = 'Default Agent',
      protocol = 'mcp',
      authToken,
      debug = false,
      timeout,
    } = options;

    const agent: AgentConfig = {
      id: agentId,
      name: agentName,
      agent_uri: agentUrl,
      protocol,
      auth_token: authToken,
    };

    ConfigurationManager.validateAgentConfig(agent);

    return new ADCPMultiAgentClient([agent], {
      debug,
      workingTimeout: timeout,
    });
  }

  // ====== SINGLE AGENT ACCESS ======

  /**
   * Get a single agent client for individual operations.
   *
   * This is the primary method for executing operations on a specific agent.
   * Returns an {@link AgentClient} instance that provides all AdCP operations.
   *
   * @param agentId - The unique identifier of the agent to retrieve
   * @returns Agent client instance for the specified agent
   * @throws {Error} If agent ID is not found in configuration
   *
   * @example
   * ```typescript
   * const client = new ADCPMultiAgentClient([
   *   { id: 'sales_agent', agent_uri: 'https://sales.example.com', protocol: 'a2a' }
   * ]);
   *
   * // Get specific agent and execute operation
   * const agent = client.agent('sales_agent');
   * const result = await agent.getProducts({ brief: 'Premium coffee brands' });
   * ```
   *
   * @see {@link AgentClient} for available operations
   */
  agent(agentId: string): AgentClient {
    const agent = this.agentClients.get(agentId);
    if (!agent) {
      throw new Error(`Agent '${agentId}' not found. Available agents: ${this.getAgentIds().join(', ')}`);
    }
    return agent;
  }

  // ====== MULTI-AGENT ACCESS ======

  /**
   * Get multiple specific agents for parallel operations.
   *
   * Returns an {@link AgentCollection} that executes operations across the specified
   * agents in parallel using Promise.all(). Useful when you want to query specific
   * agents simultaneously and compare results.
   *
   * @param agentIds - Array of agent IDs to include in the collection
   * @returns Agent collection for parallel operations across specified agents
   * @throws {Error} If any agent ID is not found in configuration
   *
   * @example
   * ```typescript
   * // Execute across specific agents
   * const results = await client.agents(['sales_agent_1', 'sales_agent_2']).getProducts({
   *   brief: 'Premium coffee brands'
   * });
   *
   * // Process parallel results
   * results.forEach((result, i) => {
   *   if (result.status === 'completed') {
   *     console.log(`Agent ${i + 1}: ${result.data.products.length} products`);
   *   }
   * });
   * ```
   *
   * @see {@link AgentCollection} for available parallel operations
   */
  agents(agentIds: string[]): AgentCollection {
    const agentConfigs: AgentConfig[] = [];

    for (const agentId of agentIds) {
      const agent = this.agentClients.get(agentId);
      if (!agent) {
        throw new Error(`Agent '${agentId}' not found. Available agents: ${this.getAgentIds().join(', ')}`);
      }
      agentConfigs.push(agent.getAgent());
    }

    return new AgentCollection(agentConfigs, this.config);
  }

  /**
   * Get all configured agents for broadcast operations.
   *
   * Returns an {@link AgentCollection} containing all agents in the client configuration.
   * Executes operations across all agents in parallel, useful for market research,
   * price comparison, or discovering capabilities across your entire agent network.
   *
   * @returns Agent collection for parallel operations across all configured agents
   *
   * @example
   * ```typescript
   * const client = new ADCPMultiAgentClient([
   *   { id: 'agent1', agent_uri: 'https://agent1.com', protocol: 'a2a' },
   *   { id: 'agent2', agent_uri: 'https://agent2.com', protocol: 'mcp' },
   *   { id: 'agent3', agent_uri: 'https://agent3.com', protocol: 'a2a' }
   * ]);
   *
   * // Query all agents simultaneously
   * const allResults = await client.allAgents().getProducts({
   *   brief: 'Premium coffee brands'
   * });
   *
   * // Find best options across all agents
   * const successfulResults = allResults.filter(r => r.status === 'completed');
   * console.log(`Got products from ${successfulResults.length} agents`);
   * ```
   *
   * @see {@link AgentCollection} for available parallel operations
   */
  allAgents(): AgentCollection {
    if (this.agentClients.size === 0) {
      throw new Error('No agents configured. Add agents to the client first.');
    }

    const agentConfigs = Array.from(this.agentClients.values()).map(agent => agent.getAgent());
    return new AgentCollection(agentConfigs, this.config);
  }

  // ====== AGENT MANAGEMENT ======

  /**
   * Add an agent to the client
   *
   * @param agentConfig - Agent configuration to add
   * @throws Error if agent ID already exists
   */
  addAgent(agentConfig: AgentConfig): void {
    if (this.agentClients.has(agentConfig.id)) {
      throw new Error(`Agent with ID '${agentConfig.id}' already exists`);
    }

    this.agentClients.set(agentConfig.id, new AgentClient(agentConfig, this.config));
  }

  /**
   * Remove an agent from the client
   *
   * @param agentId - ID of agent to remove
   * @returns True if agent was removed, false if not found
   */
  removeAgent(agentId: string): boolean {
    return this.agentClients.delete(agentId);
  }

  /**
   * Get individual agent client by ID
   *
   * @param agentId - ID of agent to retrieve
   * @returns AgentClient instance
   * @throws Error if agent not found
   */
  getAgent(agentId: string): AgentClient {
    const agent = this.agentClients.get(agentId);
    if (!agent) {
      throw new Error(`Agent '${agentId}' not found. Available agents: ${this.getAgentIds().join(', ')}`);
    }
    return agent;
  }

  /**
   * Check if an agent exists
   */
  hasAgent(agentId: string): boolean {
    return this.agentClients.has(agentId);
  }

  /**
   * Get all configured agent IDs
   */
  getAgentIds(): string[] {
    return Array.from(this.agentClients.keys());
  }

  /**
   * Get all agent configurations
   */
  getAgentConfigs(): AgentConfig[] {
    return Array.from(this.agentClients.values()).map(agent => agent.getAgent());
  }

  /**
   * Get count of configured agents
   */
  get agentCount(): number {
    return this.agentClients.size;
  }

  // ====== UTILITY METHODS ======

  /**
   * Filter agents by protocol
   */
  getAgentsByProtocol(protocol: 'mcp' | 'a2a'): AgentCollection {
    const filteredConfigs = Array.from(this.agentClients.values())
      .filter(agent => agent.getProtocol() === protocol)
      .map(agent => agent.getAgent());

    return new AgentCollection(filteredConfigs, this.config);
  }

  /**
   * Find agents that support a specific task
   * This is a placeholder - in a full implementation, you'd query agent capabilities
   */
  findAgentsForTask(taskName: string): AgentCollection {
    // For now, assume all agents support all tasks
    return this.allAgents();
  }

  /**
   * Get all active tasks across all agents
   */
  getAllActiveTasks() {
    const allTasks = [];
    for (const agent of this.agentClients.values()) {
      allTasks.push(...agent.getActiveTasks());
    }
    return allTasks;
  }

  // ====== TASK MANAGEMENT & NOTIFICATIONS ======

  /**
   * Get all tasks from all agents with detailed information
   *
   * @returns Promise resolving to array of all tasks across agents
   *
   * @example
   * ```typescript
   * const allTasks = await client.listAllTasks();
   * console.log(`Total active tasks: ${allTasks.length}`);
   * ```
   */
  async listAllTasks(): Promise<TaskInfo[]> {
    const taskPromises = Array.from(this.agentClients.values()).map(agent => agent.listTasks());
    const results = await Promise.allSettled(taskPromises);
    return results
      .filter((r): r is PromiseFulfilledResult<TaskInfo[]> => r.status === 'fulfilled')
      .flatMap(r => r.value);
  }

  /**
   * Get tasks for specific agents
   *
   * @param agentIds - Array of agent IDs to get tasks for
   * @returns Promise resolving to array of tasks from specified agents
   */
  async listTasksForAgents(agentIds: string[]): Promise<TaskInfo[]> {
    const taskPromises = agentIds.map(agentId => {
      const agent = this.agentClients.get(agentId);
      return agent ? agent.listTasks() : Promise.resolve([]);
    });
    const results = await Promise.allSettled(taskPromises);
    return results
      .filter((r): r is PromiseFulfilledResult<TaskInfo[]> => r.status === 'fulfilled')
      .flatMap(r => r.value);
  }

  /**
   * Get task information by ID from any agent
   *
   * @param taskId - ID of the task to find
   * @returns Promise resolving to task information or null if not found
   */
  async getTaskInfo(taskId: string): Promise<TaskInfo | null> {
    for (const agent of this.agentClients.values()) {
      const taskInfo = await agent.getTaskInfo(taskId);
      if (taskInfo) {
        return taskInfo;
      }
    }
    return null;
  }

  /**
   * Subscribe to task events from all agents
   *
   * @param callbacks - Event callbacks for different task events
   * @returns Unsubscribe function that removes all subscriptions
   *
   * @example
   * ```typescript
   * const unsubscribe = client.onTaskEvents({
   *   onTaskCompleted: (task) => {
   *     console.log(`Task ${task.taskName} completed!`);
   *   },
   *   onTaskFailed: (task, error) => {
   *     console.error(`Task ${task.taskName} failed:`, error);
   *   }
   * });
   * ```
   */
  onTaskEvents(callbacks: {
    onTaskCreated?: (task: TaskInfo) => void;
    onTaskUpdated?: (task: TaskInfo) => void;
    onTaskCompleted?: (task: TaskInfo) => void;
    onTaskFailed?: (task: TaskInfo, error: string) => void;
  }): () => void {
    const unsubscribers: (() => void)[] = [];

    for (const agent of this.agentClients.values()) {
      const unsubscribe = agent.onTaskEvents(callbacks);
      unsubscribers.push(unsubscribe);
    }

    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }

  /**
   * Subscribe to task updates from all agents
   *
   * @param callback - Function to call when any task status changes
   * @returns Unsubscribe function
   */
  onAnyTaskUpdate(callback: (task: TaskInfo) => void): () => void {
    const unsubscribers: (() => void)[] = [];

    for (const agent of this.agentClients.values()) {
      const unsubscribe = agent.onTaskUpdate(callback);
      unsubscribers.push(unsubscribe);
    }

    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }

  /**
   * Register webhooks for all agents
   *
   * @param webhookUrl - Base webhook URL (will append agent ID)
   * @param taskTypes - Optional array of task types to watch
   */
  async registerWebhooksForAll(webhookUrl: string, taskTypes?: string[]): Promise<void> {
    const promises = Array.from(this.agentClients.values()).map(agent =>
      agent.registerWebhook(`${webhookUrl}?agentId=${agent.getAgentId()}`, taskTypes)
    );
    await Promise.allSettled(promises);
  }

  /**
   * Unregister webhooks for all agents
   */
  async unregisterAllWebhooks(): Promise<void> {
    const promises = Array.from(this.agentClients.values()).map(agent => agent.unregisterWebhook());
    await Promise.allSettled(promises);
  }

  /**
   * Get count of active tasks by status
   *
   * @returns Promise resolving to object with counts by status
   *
   * @example
   * ```typescript
   * const counts = await client.getTaskCountsByStatus();
   * console.log(`Working: ${counts.working}, Completed: ${counts.completed}`);
   * ```
   */
  async getTaskCountsByStatus(): Promise<Record<string, number>> {
    const tasks = await this.listAllTasks();
    const counts: Record<string, number> = {};

    for (const task of tasks) {
      counts[task.status] = (counts[task.status] || 0) + 1;
    }

    return counts;
  }

  // ====== WEBHOOK METHODS ======

  /**
   * Generate webhook URL for a specific agent, task type, and operation
   *
   * @param agentId - ID of the agent
   * @param taskType - Type of task (e.g., 'get_products', 'media_buy_delivery')
   * @param operationId - Operation ID for this request
   * @returns Full webhook URL with macros replaced
   *
   * @example
   * ```typescript
   * const webhookUrl = client.getWebhookUrl('agent1', 'sync_creatives', 'op_123');
   * // Returns: https://myapp.com/webhook/sync_creatives/agent1/op_123
   * ```
   */
  getWebhookUrl(agentId: string, taskType: string, operationId: string): string {
    const agent = this.getAgent(agentId);
    return agent.getWebhookUrl(taskType, operationId);
  }

  /**
   * Handle webhook from any agent (async task completion or notifications)
   *
   * Automatically routes webhook to the correct agent based on agent_id in payload.
   *
   * @param payload - Webhook payload from agent (must contain agent_id or operation_id)
   * @param taskType - Task type (e.g create_media_buy) from url param or url part of the webhook delivery
   * @param operationId - Operation id (e.g used for client app to track the operation) from the param or url part of the webhook delivery
   * @param signature - Optional signature for verification (X-ADCP-Signature)
   * @param timestamp - Optional timestamp for verification (X-ADCP-Timestamp)
   * @returns Whether webhook was handled successfully
   *
   * @example
   * ```typescript
   * app.post('/webhook', async (req, res) => {
   *   const signature = req.headers['x-adcp-signature'];
   *   const timestamp = req.headers['x-adcp-timestamp'];
   *
   *   try {
   *     const handled = await client.handleWebhook(req.body, signature, timestamp);
   *     res.status(200).json({ received: handled });
   *   } catch (error) {
   *     res.status(401).json({ error: error.message });
   *   }
   * });
   * ```
   */
  async handleWebhook(
    payload: any,
    taskType: string,
    operationId: string,
    signature?: string,
    timestamp?: string | number
  ): Promise<boolean> {
    // Extract agent ID from payload
    // Webhook payloads include agent_id or we can infer from operation_id pattern
    const agentId = payload.agent_id || this.inferAgentIdFromPayload(payload);

    if (!agentId) {
      throw new Error('Cannot determine agent ID from webhook payload. Payload must contain agent_id or operation_id.');
    }

    const agent = this.getAgent(agentId);
    return agent.handleWebhook(payload, taskType, operationId, signature, timestamp);
  }

  /**
   * Infer agent ID from webhook payload when not explicitly provided
   *
   * Looks for patterns in operation_id or context_id that may contain agent information
   */
  private inferAgentIdFromPayload(payload: any): string | null {
    // Try to extract from operation_id pattern (e.g., "delivery_report_agent1_2024-01")
    if (payload.operation_id && typeof payload.operation_id === 'string') {
      const match = payload.operation_id.match(/_([\w-]+)_\d{4}-\d{2}$/);
      if (match && this.hasAgent(match[1])) {
        return match[1];
      }
    }

    // Try to extract from context_id if it contains agent reference
    if (payload.context_id && typeof payload.context_id === 'string') {
      for (const agentId of this.getAgentIds()) {
        if (payload.context_id.includes(agentId)) {
          return agentId;
        }
      }
    }

    return null;
  }

  // ====== CREATIVE AGENT OPERATIONS ======

  /**
   * Create a creative agent client
   *
   * @param agentUrl - URL of the creative agent
   * @param protocol - Protocol to use (defaults to 'mcp')
   * @param authToken - Optional authentication token
   * @returns CreativeAgentClient instance
   *
   * @example
   * ```typescript
   * // Use standard creative agent
   * const creativeAgent = client.createCreativeAgent(
   *   'https://creative.adcontextprotocol.org/mcp'
   * );
   *
   * // List formats
   * const formats = await creativeAgent.listFormats();
   * ```
   */
  createCreativeAgent(agentUrl: string, protocol: 'mcp' | 'a2a' = 'mcp', authToken?: string): CreativeAgentClient {
    return new CreativeAgentClient({
      agentUrl,
      protocol,
      authToken,
      ...this.config,
    });
  }

  /**
   * Get the standard AdCP creative agent
   *
   * @param protocol - Protocol to use (defaults to 'mcp')
   * @returns CreativeAgentClient instance for standard agent
   *
   * @example
   * ```typescript
   * const creativeAgent = client.getStandardCreativeAgent();
   * const formats = await creativeAgent.listFormats();
   * ```
   */
  getStandardCreativeAgent(protocol: 'mcp' | 'a2a' = 'mcp'): CreativeAgentClient {
    const agentUrl =
      protocol === 'mcp' ? STANDARD_CREATIVE_AGENTS.ADCP_REFERENCE : STANDARD_CREATIVE_AGENTS.ADCP_REFERENCE_A2A;

    return this.createCreativeAgent(agentUrl, protocol);
  }

  /**
   * Discover creative formats from standard creative agent
   *
   * Convenience method to quickly get formats from the standard AdCP creative agent
   *
   * @returns Promise resolving to array of creative formats
   *
   * @example
   * ```typescript
   * const formats = await client.discoverFormats();
   *
   * // Find specific format
   * const banner = formats.find(f => f.format_id.id === 'display_300x250_image');
   * ```
   */
  async discoverFormats(): Promise<CreativeFormat[]> {
    const creativeAgent = this.getStandardCreativeAgent();
    return creativeAgent.listFormats();
  }

  /**
   * Find creative formats by type
   *
   * @param type - Format type to filter by
   * @returns Promise resolving to matching formats
   *
   * @example
   * ```typescript
   * const videoFormats = await client.findFormatsByType('video');
   * const displayFormats = await client.findFormatsByType('display');
   * ```
   */
  async findFormatsByType(
    type: 'audio' | 'video' | 'display' | 'native' | 'dooh' | 'rich_media' | 'universal'
  ): Promise<CreativeFormat[]> {
    const creativeAgent = this.getStandardCreativeAgent();
    return creativeAgent.findByType(type);
  }

  /**
   * Find creative formats by dimensions
   *
   * @param width - Width in pixels
   * @param height - Height in pixels
   * @returns Promise resolving to matching formats
   *
   * @example
   * ```typescript
   * // Find all 300x250 formats
   * const mediumRectangles = await client.findFormatsByDimensions(300, 250);
   * ```
   */
  async findFormatsByDimensions(width: number, height: number): Promise<CreativeFormat[]> {
    const creativeAgent = this.getStandardCreativeAgent();
    return creativeAgent.findByDimensions(width, height);
  }
}

/**
 * Factory function to create a multi-agent ADCP client
 *
 * @param agents - Array of agent configurations
 * @param config - Client configuration
 * @returns Configured ADCPMultiAgentClient instance
 */
export function createADCPMultiAgentClient(
  agents: AgentConfig[],
  config?: SingleAgentClientConfig
): ADCPMultiAgentClient {
  return new ADCPMultiAgentClient(agents, config);
}
