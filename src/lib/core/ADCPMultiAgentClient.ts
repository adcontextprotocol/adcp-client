// Multi-agent orchestrator providing simple, intuitive API

import type { AgentConfig } from '../types';
import { AgentClient } from './AgentClient';
import type { ADCPClientConfig } from './ADCPClient';
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
  ListAuthorizedPropertiesRequest,
  ListAuthorizedPropertiesResponse,
  ProvidePerformanceFeedbackRequest,
  ProvidePerformanceFeedbackResponse,
  GetSignalsRequest,
  GetSignalsResponse,
  ActivateSignalRequest,
  ActivateSignalResponse
} from '../types/tools.generated';

/**
 * Collection of agent clients for parallel operations
 */
export class AgentCollection {
  private clients: Map<string, AgentClient> = new Map();

  constructor(
    private agents: AgentConfig[],
    private config: ADCPClientConfig = {}
  ) {
    for (const agent of agents) {
      this.clients.set(agent.id, new AgentClient(agent, config));
    }
  }

  // ====== PARALLEL TASK EXECUTION ======

  /**
   * Execute getProducts on all agents in parallel
   */
  async getProducts(params: GetProductsRequest, inputHandler?: InputHandler, options?: TaskOptions): Promise<TaskResult<GetProductsResponse>[]> {
    const promises = Array.from(this.clients.values()).map((client) => client.getProducts(params, inputHandler, options));
    return Promise.all(promises);
  }

  /**
   * Execute listCreativeFormats on all agents in parallel
   */
  async listCreativeFormats(params: ListCreativeFormatsRequest, inputHandler?: InputHandler, options?: TaskOptions): Promise<TaskResult<ListCreativeFormatsResponse>[]> {
    const promises = Array.from(this.clients.values()).map((client) => client.listCreativeFormats(params, inputHandler, options));
    return Promise.all(promises);
  }

  /**
   * Execute createMediaBuy on all agents in parallel
   * Note: This might not make sense for all use cases, but provided for completeness
   */
  async createMediaBuy(params: CreateMediaBuyRequest, inputHandler?: InputHandler, options?: TaskOptions): Promise<TaskResult<CreateMediaBuyResponse>[]> {
    const promises = Array.from(this.clients.values()).map((client) => client.createMediaBuy(params, inputHandler, options));
    return Promise.all(promises);
  }

  /**
   * Execute updateMediaBuy on all agents in parallel
   */
  async updateMediaBuy(params: UpdateMediaBuyRequest, inputHandler?: InputHandler, options?: TaskOptions): Promise<TaskResult<UpdateMediaBuyResponse>[]> {
    const promises = Array.from(this.clients.values()).map((client) => client.updateMediaBuy(params, inputHandler, options));
    return Promise.all(promises);
  }

  /**
   * Execute syncCreatives on all agents in parallel
   */
  async syncCreatives(params: SyncCreativesRequest, inputHandler?: InputHandler, options?: TaskOptions): Promise<TaskResult<SyncCreativesResponse>[]> {
    const promises = Array.from(this.clients.values()).map((client) => client.syncCreatives(params, inputHandler, options));
    return Promise.all(promises);
  }

  /**
   * Execute listCreatives on all agents in parallel
   */
  async listCreatives(params: ListCreativesRequest, inputHandler?: InputHandler, options?: TaskOptions): Promise<TaskResult<ListCreativesResponse>[]> {
    const promises = Array.from(this.clients.values()).map((client) => client.listCreatives(params, inputHandler, options));
    return Promise.all(promises);
  }

  /**
   * Execute getMediaBuyDelivery on all agents in parallel
   */
  async getMediaBuyDelivery(params: GetMediaBuyDeliveryRequest, inputHandler?: InputHandler, options?: TaskOptions): Promise<TaskResult<GetMediaBuyDeliveryResponse>[]> {
    const promises = Array.from(this.clients.values()).map((client) => client.getMediaBuyDelivery(params, inputHandler, options));
    return Promise.all(promises);
  }

  /**
   * Execute listAuthorizedProperties on all agents in parallel
   */
  async listAuthorizedProperties(params: ListAuthorizedPropertiesRequest, inputHandler?: InputHandler, options?: TaskOptions): Promise<TaskResult<ListAuthorizedPropertiesResponse>[]> {
    const promises = Array.from(this.clients.values()).map((client) => client.listAuthorizedProperties(params, inputHandler, options));
    return Promise.all(promises);
  }

  /**
   * Execute providePerformanceFeedback on all agents in parallel
   */
  async providePerformanceFeedback(params: ProvidePerformanceFeedbackRequest, inputHandler?: InputHandler, options?: TaskOptions): Promise<TaskResult<ProvidePerformanceFeedbackResponse>[]> {
    const promises = Array.from(this.clients.values()).map((client) => client.providePerformanceFeedback(params, inputHandler, options));
    return Promise.all(promises);
  }

  /**
   * Execute getSignals on all agents in parallel
   */
  async getSignals(params: GetSignalsRequest, inputHandler?: InputHandler, options?: TaskOptions): Promise<TaskResult<GetSignalsResponse>[]> {
    const promises = Array.from(this.clients.values()).map((client) => client.getSignals(params, inputHandler, options));
    return Promise.all(promises);
  }

  /**
   * Execute activateSignal on all agents in parallel
   */
  async activateSignal(params: ActivateSignalRequest, inputHandler?: InputHandler, options?: TaskOptions): Promise<TaskResult<ActivateSignalResponse>[]> {
    const promises = Array.from(this.clients.values()).map((client) => client.activateSignal(params, inputHandler, options));
    return Promise.all(promises);
  }

  // ====== COLLECTION UTILITIES ======

  /**
   * Get individual agent client
   */
  getAgent(agentId: string): AgentClient {
    const client = this.clients.get(agentId);
    if (!client) {
      throw new Error(`Agent '${agentId}' not found in collection. Available: ${Array.from(this.clients.keys()).join(', ')}`);
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
   * Execute a custom function on all agents in parallel
   */
  async execute<T>(executor: (agent: AgentClient) => Promise<T>): Promise<T[]> {
    const promises = Array.from(this.clients.values()).map(executor);
    return Promise.all(promises);
  }
}

/**
 * Main multi-agent ADCP client providing simple, intuitive API
 *
 * This is the primary entry point for most users. It provides:
 * - Single agent access via agent(id)
 * - Multi-agent access via agents([ids])
 * - Broadcast access via allAgents()
 * - Simple parallel execution using Promise.all()
 *
 * @example Basic usage
 * ```typescript
 * const client = new ADCPMultiAgentClient([
 *   { id: 'agent1', name: 'Agent 1', agent_uri: 'https://agent1.com', protocol: 'mcp' },
 *   { id: 'agent2', name: 'Agent 2', agent_uri: 'https://agent2.com', protocol: 'a2a' }
 * ]);
 *
 * // Single agent
 * const result = await client.agent('agent1').getProducts(params, handler);
 *
 * // Multiple specific agents
 * const results = await client.agents(['agent1', 'agent2']).getProducts(params, handler);
 *
 * // All agents
 * const allResults = await client.allAgents().getProducts(params, handler);
 * ```
 */
export class ADCPMultiAgentClient {
  private agentClients: Map<string, AgentClient> = new Map();

  constructor(
    agentConfigs: AgentConfig[],
    private config: ADCPClientConfig = {}
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
  static fromConfig(config?: ADCPClientConfig): ADCPMultiAgentClient {
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
  static fromEnv(config?: ADCPClientConfig): ADCPMultiAgentClient {
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
  static fromFile(configPath?: string, config?: ADCPClientConfig): ADCPMultiAgentClient {
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
   *   requiresAuth: true,
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
      requiresAuth?: boolean;
      authTokenEnv?: string;
      debug?: boolean;
      timeout?: number;
    } = {}
  ): ADCPMultiAgentClient {
    const { agentId = 'default-agent', agentName = 'Default Agent', protocol = 'mcp', requiresAuth = false, authTokenEnv, debug = false, timeout } = options;

    const agent: AgentConfig = {
      id: agentId,
      name: agentName,
      agent_uri: agentUrl,
      protocol,
      requiresAuth,
      auth_token_env: authTokenEnv
    };

    ConfigurationManager.validateAgentConfig(agent);

    return new ADCPMultiAgentClient([agent], {
      debug,
      workingTimeout: timeout
    });
  }

  // ====== SINGLE AGENT ACCESS ======

  /**
   * Get a single agent for operations
   *
   * @param agentId - ID of the agent to get
   * @returns AgentClient for the specified agent
   * @throws Error if agent not found
   *
   * @example
   * ```typescript
   * const agent = client.agent('premium-agent');
   * const products = await agent.getProducts({ brief: 'Coffee brands' }, handler);
   * const refined = await agent.continueConversation('Focus on premium brands');
   * ```
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
   * Get multiple specific agents for parallel operations
   *
   * @param agentIds - Array of agent IDs
   * @returns AgentCollection for parallel operations
   * @throws Error if any agent not found
   *
   * @example
   * ```typescript
   * const agents = client.agents(['agent1', 'agent2']);
   * const results = await agents.getProducts({ brief: 'Coffee brands' }, handler);
   *
   * // Process results
   * results.forEach(result => {
   *   if (result.success) {
   *     console.log(`${result.metadata.agent.name}: ${result.data.products.length} products`);
   *   }
   * });
   * ```
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
   * Get all configured agents for broadcast operations
   *
   * @returns AgentCollection containing all agents
   *
   * @example
   * ```typescript
   * const allResults = await client.allAgents().getProducts({
   *   brief: 'Premium coffee brands'
   * }, handler);
   *
   * // Find best result
   * const successful = allResults.filter(r => r.success);
   * const bestResult = successful.sort((a, b) =>
   *   b.data.products.length - a.data.products.length
   * )[0];
   * ```
   */
  allAgents(): AgentCollection {
    if (this.agentClients.size === 0) {
      throw new Error('No agents configured. Add agents to the client first.');
    }

    const agentConfigs = Array.from(this.agentClients.values()).map((agent) => agent.getAgent());
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
    return Array.from(this.agentClients.values()).map((agent) => agent.getAgent());
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
      .filter((agent) => agent.getProtocol() === protocol)
      .map((agent) => agent.getAgent());

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
    const taskPromises = Array.from(this.agentClients.values()).map((agent) => agent.listTasks());
    const taskArrays = await Promise.all(taskPromises);
    return taskArrays.flat();
  }

  /**
   * Get tasks for specific agents
   *
   * @param agentIds - Array of agent IDs to get tasks for
   * @returns Promise resolving to array of tasks from specified agents
   */
  async listTasksForAgents(agentIds: string[]): Promise<TaskInfo[]> {
    const taskPromises = agentIds.map((agentId) => {
      const agent = this.agentClients.get(agentId);
      return agent ? agent.listTasks() : Promise.resolve([]);
    });
    const taskArrays = await Promise.all(taskPromises);
    return taskArrays.flat();
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
      unsubscribers.forEach((unsub) => unsub());
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
      unsubscribers.forEach((unsub) => unsub());
    };
  }

  /**
   * Register webhooks for all agents
   *
   * @param webhookUrl - Base webhook URL (will append agent ID)
   * @param taskTypes - Optional array of task types to watch
   */
  async registerWebhooksForAll(webhookUrl: string, taskTypes?: string[]): Promise<void> {
    const promises = Array.from(this.agentClients.values()).map((agent) => agent.registerWebhook(`${webhookUrl}?agentId=${agent.getAgentId()}`, taskTypes));
    await Promise.all(promises);
  }

  /**
   * Unregister webhooks for all agents
   */
  async unregisterAllWebhooks(): Promise<void> {
    const promises = Array.from(this.agentClients.values()).map((agent) => agent.unregisterWebhook());
    await Promise.all(promises);
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
      ...this.config
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
    const agentUrl = protocol === 'mcp' ? STANDARD_CREATIVE_AGENTS.ADCP_REFERENCE : STANDARD_CREATIVE_AGENTS.ADCP_REFERENCE_A2A;

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
  async findFormatsByType(type: 'audio' | 'video' | 'display' | 'native' | 'dooh' | 'rich_media' | 'universal'): Promise<CreativeFormat[]> {
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
export function createADCPMultiAgentClient(agents: AgentConfig[], config?: ADCPClientConfig): ADCPMultiAgentClient {
  return new ADCPMultiAgentClient(agents, config);
}
