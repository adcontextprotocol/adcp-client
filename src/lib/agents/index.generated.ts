// Generated Agent Classes
// Auto-generated from AdCP tool definitions

import type { AgentConfig } from '../types';
import { ProtocolClient } from '../protocols';
import { validateAgentUrl } from '../validation';
import { getCircuitBreaker, unwrapProtocolResponse } from '../utils';
import type {
  GetProductsRequest,
  GetProductsResponse,
  ListCreativeFormatsRequest,
  ListCreativeFormatsResponse,
  CreateMediaBuyRequest,
  CreateMediaBuyResponse,
  SyncCreativesRequest,
  SyncCreativesResponse,
  ListCreativesRequest,
  ListCreativesResponse,
  UpdateMediaBuyRequest,
  UpdateMediaBuyResponse,
  GetMediaBuyDeliveryRequest,
  GetMediaBuyDeliveryResponse,
  ListAuthorizedPropertiesRequest,
  ListAuthorizedPropertiesResponse,
  ProvidePerformanceFeedbackRequest,
  ProvidePerformanceFeedbackResponse,
  BuildCreativeRequest,
  BuildCreativeResponse,
  PreviewCreativeRequest,
  PreviewCreativeResponse,
  GetSignalsRequest,
  GetSignalsResponse,
  ActivateSignalRequest,
  ActivateSignalResponse
} from '../types/tools.generated';

/**
 * Single agent operations with full type safety
 *
 * Returns raw AdCP responses matching schema exactly.
 * No SDK wrapping - responses follow AdCP discriminated union patterns.
 */
export class Agent {
  constructor(
    private config: AgentConfig,
    private client: any // Will be AdCPClient
  ) {}

  private async callTool<T>(toolName: string, params: any): Promise<T> {
    const debugLogs: any[] = [];

    try {
      validateAgentUrl(this.config.agent_uri);

      const circuitBreaker = getCircuitBreaker(this.config.id);
      const protocolResponse = await circuitBreaker.call(async () => {
        return await ProtocolClient.callTool(this.config, toolName, params, debugLogs);
      });

      // Unwrap protocol response to get raw AdCP data
      const adcpResponse = unwrapProtocolResponse(protocolResponse);

      return adcpResponse as T;
    } catch (error) {
      // Convert exceptions to AdCP error format
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        errors: [{
          code: 'client_error',
          message: errorMessage
        }]
      } as T;
    }
  }

  /**
   * Official AdCP get_products tool schema
   * Official AdCP get_products tool schema
   */
  async getProducts(params: GetProductsRequest): Promise<GetProductsResponse> {
    return this.callTool<GetProductsResponse>('get_products', params);
  }

  /**
   * Official AdCP list_creative_formats tool schema
   * Official AdCP list_creative_formats tool schema
   */
  async listCreativeFormats(params: ListCreativeFormatsRequest): Promise<ListCreativeFormatsResponse> {
    return this.callTool<ListCreativeFormatsResponse>('list_creative_formats', params);
  }

  /**
   * Official AdCP create_media_buy tool schema
   * Official AdCP create_media_buy tool schema
   */
  async createMediaBuy(params: CreateMediaBuyRequest): Promise<CreateMediaBuyResponse> {
    return this.callTool<CreateMediaBuyResponse>('create_media_buy', params);
  }

  /**
   * Official AdCP sync_creatives tool schema
   * Official AdCP sync_creatives tool schema
   */
  async syncCreatives(params: SyncCreativesRequest): Promise<SyncCreativesResponse> {
    return this.callTool<SyncCreativesResponse>('sync_creatives', params);
  }

  /**
   * Official AdCP list_creatives tool schema
   * Official AdCP list_creatives tool schema
   */
  async listCreatives(params: ListCreativesRequest): Promise<ListCreativesResponse> {
    return this.callTool<ListCreativesResponse>('list_creatives', params);
  }

  /**
   * Official AdCP update_media_buy tool schema
   * Official AdCP update_media_buy tool schema
   */
  async updateMediaBuy(params: UpdateMediaBuyRequest): Promise<UpdateMediaBuyResponse> {
    return this.callTool<UpdateMediaBuyResponse>('update_media_buy', params);
  }

  /**
   * Official AdCP get_media_buy_delivery tool schema
   * Official AdCP get_media_buy_delivery tool schema
   */
  async getMediaBuyDelivery(params: GetMediaBuyDeliveryRequest): Promise<GetMediaBuyDeliveryResponse> {
    return this.callTool<GetMediaBuyDeliveryResponse>('get_media_buy_delivery', params);
  }

  /**
   * Official AdCP list_authorized_properties tool schema
   * Official AdCP list_authorized_properties tool schema
   */
  async listAuthorizedProperties(params: ListAuthorizedPropertiesRequest): Promise<ListAuthorizedPropertiesResponse> {
    return this.callTool<ListAuthorizedPropertiesResponse>('list_authorized_properties', params);
  }

  /**
   * Official AdCP provide_performance_feedback tool schema
   * Official AdCP provide_performance_feedback tool schema
   */
  async providePerformanceFeedback(params: ProvidePerformanceFeedbackRequest): Promise<ProvidePerformanceFeedbackResponse> {
    return this.callTool<ProvidePerformanceFeedbackResponse>('provide_performance_feedback', params);
  }

  /**
   * Official AdCP build_creative tool schema
   * Official AdCP build_creative tool schema
   */
  async buildCreative(params: BuildCreativeRequest): Promise<BuildCreativeResponse> {
    return this.callTool<BuildCreativeResponse>('build_creative', params);
  }

  /**
   * Official AdCP preview_creative tool schema
   * Official AdCP preview_creative tool schema
   */
  async previewCreative(params: PreviewCreativeRequest): Promise<PreviewCreativeResponse> {
    return this.callTool<PreviewCreativeResponse>('preview_creative', params);
  }

  /**
   * Official AdCP get_signals tool schema
   * Official AdCP get_signals tool schema
   */
  async getSignals(params: GetSignalsRequest): Promise<GetSignalsResponse> {
    return this.callTool<GetSignalsResponse>('get_signals', params);
  }

  /**
   * Official AdCP activate_signal tool schema
   * Official AdCP activate_signal tool schema
   */
  async activateSignal(params: ActivateSignalRequest): Promise<ActivateSignalResponse> {
    return this.callTool<ActivateSignalResponse>('activate_signal', params);
  }

}

/**
 * Multi-agent operations with full type safety
 */
export class AgentCollection {
  constructor(
    private configs: AgentConfig[],
    private client: any // Will be AdCPClient
  ) {}

  private async callToolOnAll<T>(toolName: string, params: any): Promise<T[]> {
    const agents = this.configs.map(config => new Agent(config, this.client));
    const promises = agents.map(agent => (agent as any).callTool(toolName, params));
    return Promise.all(promises);
  }

  /**
   * Official AdCP get_products tool schema (across multiple agents)
   * Official AdCP get_products tool schema
   */
  async getProducts(params: GetProductsRequest): Promise<GetProductsResponse[]> {
    return this.callToolOnAll<GetProductsResponse>('get_products', params);
  }

  /**
   * Official AdCP list_creative_formats tool schema (across multiple agents)
   * Official AdCP list_creative_formats tool schema
   */
  async listCreativeFormats(params: ListCreativeFormatsRequest): Promise<ListCreativeFormatsResponse[]> {
    return this.callToolOnAll<ListCreativeFormatsResponse>('list_creative_formats', params);
  }

  /**
   * Official AdCP sync_creatives tool schema (across multiple agents)
   * Official AdCP sync_creatives tool schema
   */
  async syncCreatives(params: SyncCreativesRequest): Promise<SyncCreativesResponse[]> {
    return this.callToolOnAll<SyncCreativesResponse>('sync_creatives', params);
  }

  /**
   * Official AdCP list_creatives tool schema (across multiple agents)
   * Official AdCP list_creatives tool schema
   */
  async listCreatives(params: ListCreativesRequest): Promise<ListCreativesResponse[]> {
    return this.callToolOnAll<ListCreativesResponse>('list_creatives', params);
  }

  /**
   * Official AdCP get_media_buy_delivery tool schema (across multiple agents)
   * Official AdCP get_media_buy_delivery tool schema
   */
  async getMediaBuyDelivery(params: GetMediaBuyDeliveryRequest): Promise<GetMediaBuyDeliveryResponse[]> {
    return this.callToolOnAll<GetMediaBuyDeliveryResponse>('get_media_buy_delivery', params);
  }

  /**
   * Official AdCP list_authorized_properties tool schema (across multiple agents)
   * Official AdCP list_authorized_properties tool schema
   */
  async listAuthorizedProperties(params: ListAuthorizedPropertiesRequest): Promise<ListAuthorizedPropertiesResponse[]> {
    return this.callToolOnAll<ListAuthorizedPropertiesResponse>('list_authorized_properties', params);
  }

  /**
   * Official AdCP provide_performance_feedback tool schema (across multiple agents)
   * Official AdCP provide_performance_feedback tool schema
   */
  async providePerformanceFeedback(params: ProvidePerformanceFeedbackRequest): Promise<ProvidePerformanceFeedbackResponse[]> {
    return this.callToolOnAll<ProvidePerformanceFeedbackResponse>('provide_performance_feedback', params);
  }

  /**
   * Official AdCP build_creative tool schema (across multiple agents)
   * Official AdCP build_creative tool schema
   */
  async buildCreative(params: BuildCreativeRequest): Promise<BuildCreativeResponse[]> {
    return this.callToolOnAll<BuildCreativeResponse>('build_creative', params);
  }

  /**
   * Official AdCP preview_creative tool schema (across multiple agents)
   * Official AdCP preview_creative tool schema
   */
  async previewCreative(params: PreviewCreativeRequest): Promise<PreviewCreativeResponse[]> {
    return this.callToolOnAll<PreviewCreativeResponse>('preview_creative', params);
  }

  /**
   * Official AdCP get_signals tool schema (across multiple agents)
   * Official AdCP get_signals tool schema
   */
  async getSignals(params: GetSignalsRequest): Promise<GetSignalsResponse[]> {
    return this.callToolOnAll<GetSignalsResponse>('get_signals', params);
  }

  /**
   * Official AdCP activate_signal tool schema (across multiple agents)
   * Official AdCP activate_signal tool schema
   */
  async activateSignal(params: ActivateSignalRequest): Promise<ActivateSignalResponse[]> {
    return this.callToolOnAll<ActivateSignalResponse>('activate_signal', params);
  }

}
