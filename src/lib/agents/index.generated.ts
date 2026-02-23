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
  GetMediaBuysRequest,
  GetMediaBuysResponse,
  GetMediaBuyDeliveryRequest,
  GetMediaBuyDeliveryResponse,
  ProvidePerformanceFeedbackRequest,
  ProvidePerformanceFeedbackResponse,
  SyncEventSourcesRequest,
  SyncEventSourcesResponse,
  LogEventRequest,
  LogEventResponse,
  SyncAudiencesRequest,
  SyncAudiencesResponse,
  SyncCatalogsRequest,
  SyncCatalogsResponse,
  BuildCreativeRequest,
  BuildCreativeResponse,
  PreviewCreativeRequest,
  PreviewCreativeResponse,
  GetCreativeDeliveryRequest,
  GetCreativeDeliveryResponse,
  GetSignalsRequest,
  GetSignalsResponse,
  ActivateSignalRequest,
  ActivateSignalResponse,
  CreatePropertyListRequest,
  CreatePropertyListResponse,
  UpdatePropertyListRequest,
  UpdatePropertyListResponse,
  GetPropertyListRequest,
  GetPropertyListResponse,
  ListPropertyListsRequest,
  ListPropertyListsResponse,
  DeletePropertyListRequest,
  DeletePropertyListResponse,
  ListContentStandardsRequest,
  ListContentStandardsResponse,
  GetContentStandardsRequest,
  GetContentStandardsResponse,
  CreateContentStandardsRequest,
  CreateContentStandardsResponse,
  UpdateContentStandardsRequest,
  UpdateContentStandardsResponse,
  CalibrateContentRequest,
  CalibrateContentResponse,
  ValidateContentDeliveryRequest,
  ValidateContentDeliveryResponse,
  GetMediaBuyArtifactsRequest,
  GetMediaBuyArtifactsResponse,
  GetCreativeFeaturesRequest,
  GetCreativeFeaturesResponse,
  SIGetOfferingRequest,
  SIGetOfferingResponse,
  SIInitiateSessionRequest,
  SIInitiateSessionResponse,
  SISendMessageRequest,
  SISendMessageResponse,
  SITerminateSessionRequest,
  SITerminateSessionResponse,
  GetAdCPCapabilitiesRequest,
  GetAdCPCapabilitiesResponse,
  ListAccountsRequest,
  ListAccountsResponse,
  SyncAccountsRequest,
  SyncAccountsResponse
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

      // Unwrap and validate protocol response using tool-specific Zod schema
      const adcpResponse = unwrapProtocolResponse(protocolResponse, toolName, this.config.protocol);

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
   */
  async getProducts(params: GetProductsRequest): Promise<GetProductsResponse> {
    return this.callTool<GetProductsResponse>('get_products', params);
  }

  /**
   * Official AdCP list_creative_formats tool schema
   */
  async listCreativeFormats(params: ListCreativeFormatsRequest): Promise<ListCreativeFormatsResponse> {
    return this.callTool<ListCreativeFormatsResponse>('list_creative_formats', params);
  }

  /**
   * Official AdCP create_media_buy tool schema
   */
  async createMediaBuy(params: CreateMediaBuyRequest): Promise<CreateMediaBuyResponse> {
    return this.callTool<CreateMediaBuyResponse>('create_media_buy', params);
  }

  /**
   * Official AdCP sync_creatives tool schema
   */
  async syncCreatives(params: SyncCreativesRequest): Promise<SyncCreativesResponse> {
    return this.callTool<SyncCreativesResponse>('sync_creatives', params);
  }

  /**
   * Official AdCP list_creatives tool schema
   */
  async listCreatives(params: ListCreativesRequest): Promise<ListCreativesResponse> {
    return this.callTool<ListCreativesResponse>('list_creatives', params);
  }

  /**
   * Official AdCP update_media_buy tool schema
   */
  async updateMediaBuy(params: UpdateMediaBuyRequest): Promise<UpdateMediaBuyResponse> {
    return this.callTool<UpdateMediaBuyResponse>('update_media_buy', params);
  }

  /**
   * Official AdCP get_media_buys tool schema
   */
  async getMediaBuys(params: GetMediaBuysRequest): Promise<GetMediaBuysResponse> {
    return this.callTool<GetMediaBuysResponse>('get_media_buys', params);
  }

  /**
   * Official AdCP get_media_buy_delivery tool schema
   */
  async getMediaBuyDelivery(params: GetMediaBuyDeliveryRequest): Promise<GetMediaBuyDeliveryResponse> {
    return this.callTool<GetMediaBuyDeliveryResponse>('get_media_buy_delivery', params);
  }

  /**
   * Official AdCP provide_performance_feedback tool schema
   */
  async providePerformanceFeedback(params: ProvidePerformanceFeedbackRequest): Promise<ProvidePerformanceFeedbackResponse> {
    return this.callTool<ProvidePerformanceFeedbackResponse>('provide_performance_feedback', params);
  }

  /**
   * Official AdCP sync_event_sources tool schema
   */
  async syncEventSources(params: SyncEventSourcesRequest): Promise<SyncEventSourcesResponse> {
    return this.callTool<SyncEventSourcesResponse>('sync_event_sources', params);
  }

  /**
   * Official AdCP log_event tool schema
   */
  async logEvent(params: LogEventRequest): Promise<LogEventResponse> {
    return this.callTool<LogEventResponse>('log_event', params);
  }

  /**
   * Official AdCP sync_audiences tool schema
   */
  async syncAudiences(params: SyncAudiencesRequest): Promise<SyncAudiencesResponse> {
    return this.callTool<SyncAudiencesResponse>('sync_audiences', params);
  }

  /**
   * Official AdCP sync_catalogs tool schema
   */
  async syncCatalogs(params: SyncCatalogsRequest): Promise<SyncCatalogsResponse> {
    return this.callTool<SyncCatalogsResponse>('sync_catalogs', params);
  }

  /**
   * Official AdCP build_creative tool schema
   */
  async buildCreative(params: BuildCreativeRequest): Promise<BuildCreativeResponse> {
    return this.callTool<BuildCreativeResponse>('build_creative', params);
  }

  /**
   * Official AdCP preview_creative tool schema
   */
  async previewCreative(params: PreviewCreativeRequest): Promise<PreviewCreativeResponse> {
    return this.callTool<PreviewCreativeResponse>('preview_creative', params);
  }

  /**
   * Official AdCP get_creative_delivery tool schema
   */
  async getCreativeDelivery(params: GetCreativeDeliveryRequest): Promise<GetCreativeDeliveryResponse> {
    return this.callTool<GetCreativeDeliveryResponse>('get_creative_delivery', params);
  }

  /**
   * Official AdCP get_signals tool schema
   */
  async getSignals(params: GetSignalsRequest): Promise<GetSignalsResponse> {
    return this.callTool<GetSignalsResponse>('get_signals', params);
  }

  /**
   * Official AdCP activate_signal tool schema
   */
  async activateSignal(params: ActivateSignalRequest): Promise<ActivateSignalResponse> {
    return this.callTool<ActivateSignalResponse>('activate_signal', params);
  }

  /**
   * Official AdCP create_property_list tool schema
   */
  async createPropertyList(params: CreatePropertyListRequest): Promise<CreatePropertyListResponse> {
    return this.callTool<CreatePropertyListResponse>('create_property_list', params);
  }

  /**
   * Official AdCP update_property_list tool schema
   */
  async updatePropertyList(params: UpdatePropertyListRequest): Promise<UpdatePropertyListResponse> {
    return this.callTool<UpdatePropertyListResponse>('update_property_list', params);
  }

  /**
   * Official AdCP get_property_list tool schema
   */
  async getPropertyList(params: GetPropertyListRequest): Promise<GetPropertyListResponse> {
    return this.callTool<GetPropertyListResponse>('get_property_list', params);
  }

  /**
   * Official AdCP list_property_lists tool schema
   */
  async listPropertyLists(params: ListPropertyListsRequest): Promise<ListPropertyListsResponse> {
    return this.callTool<ListPropertyListsResponse>('list_property_lists', params);
  }

  /**
   * Official AdCP delete_property_list tool schema
   */
  async deletePropertyList(params: DeletePropertyListRequest): Promise<DeletePropertyListResponse> {
    return this.callTool<DeletePropertyListResponse>('delete_property_list', params);
  }

  /**
   * Official AdCP list_content_standards tool schema
   */
  async listContentStandards(params: ListContentStandardsRequest): Promise<ListContentStandardsResponse> {
    return this.callTool<ListContentStandardsResponse>('list_content_standards', params);
  }

  /**
   * Official AdCP get_content_standards tool schema
   */
  async getContentStandards(params: GetContentStandardsRequest): Promise<GetContentStandardsResponse> {
    return this.callTool<GetContentStandardsResponse>('get_content_standards', params);
  }

  /**
   * Official AdCP create_content_standards tool schema
   */
  async createContentStandards(params: CreateContentStandardsRequest): Promise<CreateContentStandardsResponse> {
    return this.callTool<CreateContentStandardsResponse>('create_content_standards', params);
  }

  /**
   * Official AdCP update_content_standards tool schema
   */
  async updateContentStandards(params: UpdateContentStandardsRequest): Promise<UpdateContentStandardsResponse> {
    return this.callTool<UpdateContentStandardsResponse>('update_content_standards', params);
  }

  /**
   * Official AdCP calibrate_content tool schema
   */
  async calibrateContent(params: CalibrateContentRequest): Promise<CalibrateContentResponse> {
    return this.callTool<CalibrateContentResponse>('calibrate_content', params);
  }

  /**
   * Official AdCP validate_content_delivery tool schema
   */
  async validateContentDelivery(params: ValidateContentDeliveryRequest): Promise<ValidateContentDeliveryResponse> {
    return this.callTool<ValidateContentDeliveryResponse>('validate_content_delivery', params);
  }

  /**
   * Official AdCP get_media_buy_artifacts tool schema
   */
  async getMediaBuyArtifacts(params: GetMediaBuyArtifactsRequest): Promise<GetMediaBuyArtifactsResponse> {
    return this.callTool<GetMediaBuyArtifactsResponse>('get_media_buy_artifacts', params);
  }

  /**
   * Official AdCP get_creative_features tool schema
   */
  async getCreativeFeatures(params: GetCreativeFeaturesRequest): Promise<GetCreativeFeaturesResponse> {
    return this.callTool<GetCreativeFeaturesResponse>('get_creative_features', params);
  }

  /**
   * Official AdCP si_get_offering tool schema
   */
  async siGetOffering(params: SIGetOfferingRequest): Promise<SIGetOfferingResponse> {
    return this.callTool<SIGetOfferingResponse>('si_get_offering', params);
  }

  /**
   * Official AdCP si_initiate_session tool schema
   */
  async siInitiateSession(params: SIInitiateSessionRequest): Promise<SIInitiateSessionResponse> {
    return this.callTool<SIInitiateSessionResponse>('si_initiate_session', params);
  }

  /**
   * Official AdCP si_send_message tool schema
   */
  async siSendMessage(params: SISendMessageRequest): Promise<SISendMessageResponse> {
    return this.callTool<SISendMessageResponse>('si_send_message', params);
  }

  /**
   * Official AdCP si_terminate_session tool schema
   */
  async siTerminateSession(params: SITerminateSessionRequest): Promise<SITerminateSessionResponse> {
    return this.callTool<SITerminateSessionResponse>('si_terminate_session', params);
  }

  /**
   * Official AdCP get_adcp_capabilities tool schema
   */
  async getAdcpCapabilities(params: GetAdCPCapabilitiesRequest): Promise<GetAdCPCapabilitiesResponse> {
    return this.callTool<GetAdCPCapabilitiesResponse>('get_adcp_capabilities', params);
  }

  /**
   * Official AdCP list_accounts tool schema
   */
  async listAccounts(params: ListAccountsRequest): Promise<ListAccountsResponse> {
    return this.callTool<ListAccountsResponse>('list_accounts', params);
  }

  /**
   * Official AdCP sync_accounts tool schema
   */
  async syncAccounts(params: SyncAccountsRequest): Promise<SyncAccountsResponse> {
    return this.callTool<SyncAccountsResponse>('sync_accounts', params);
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
   */
  async getProducts(params: GetProductsRequest): Promise<GetProductsResponse[]> {
    return this.callToolOnAll<GetProductsResponse>('get_products', params);
  }

  /**
   * Official AdCP list_creative_formats tool schema (across multiple agents)
   */
  async listCreativeFormats(params: ListCreativeFormatsRequest): Promise<ListCreativeFormatsResponse[]> {
    return this.callToolOnAll<ListCreativeFormatsResponse>('list_creative_formats', params);
  }

  /**
   * Official AdCP sync_creatives tool schema (across multiple agents)
   */
  async syncCreatives(params: SyncCreativesRequest): Promise<SyncCreativesResponse[]> {
    return this.callToolOnAll<SyncCreativesResponse>('sync_creatives', params);
  }

  /**
   * Official AdCP list_creatives tool schema (across multiple agents)
   */
  async listCreatives(params: ListCreativesRequest): Promise<ListCreativesResponse[]> {
    return this.callToolOnAll<ListCreativesResponse>('list_creatives', params);
  }

  /**
   * Official AdCP get_media_buys tool schema (across multiple agents)
   */
  async getMediaBuys(params: GetMediaBuysRequest): Promise<GetMediaBuysResponse[]> {
    return this.callToolOnAll<GetMediaBuysResponse>('get_media_buys', params);
  }

  /**
   * Official AdCP get_media_buy_delivery tool schema (across multiple agents)
   */
  async getMediaBuyDelivery(params: GetMediaBuyDeliveryRequest): Promise<GetMediaBuyDeliveryResponse[]> {
    return this.callToolOnAll<GetMediaBuyDeliveryResponse>('get_media_buy_delivery', params);
  }

  /**
   * Official AdCP provide_performance_feedback tool schema (across multiple agents)
   */
  async providePerformanceFeedback(params: ProvidePerformanceFeedbackRequest): Promise<ProvidePerformanceFeedbackResponse[]> {
    return this.callToolOnAll<ProvidePerformanceFeedbackResponse>('provide_performance_feedback', params);
  }

  /**
   * Official AdCP sync_event_sources tool schema (across multiple agents)
   */
  async syncEventSources(params: SyncEventSourcesRequest): Promise<SyncEventSourcesResponse[]> {
    return this.callToolOnAll<SyncEventSourcesResponse>('sync_event_sources', params);
  }

  /**
   * Official AdCP log_event tool schema (across multiple agents)
   */
  async logEvent(params: LogEventRequest): Promise<LogEventResponse[]> {
    return this.callToolOnAll<LogEventResponse>('log_event', params);
  }

  /**
   * Official AdCP sync_audiences tool schema (across multiple agents)
   */
  async syncAudiences(params: SyncAudiencesRequest): Promise<SyncAudiencesResponse[]> {
    return this.callToolOnAll<SyncAudiencesResponse>('sync_audiences', params);
  }

  /**
   * Official AdCP sync_catalogs tool schema (across multiple agents)
   */
  async syncCatalogs(params: SyncCatalogsRequest): Promise<SyncCatalogsResponse[]> {
    return this.callToolOnAll<SyncCatalogsResponse>('sync_catalogs', params);
  }

  /**
   * Official AdCP build_creative tool schema (across multiple agents)
   */
  async buildCreative(params: BuildCreativeRequest): Promise<BuildCreativeResponse[]> {
    return this.callToolOnAll<BuildCreativeResponse>('build_creative', params);
  }

  /**
   * Official AdCP preview_creative tool schema (across multiple agents)
   */
  async previewCreative(params: PreviewCreativeRequest): Promise<PreviewCreativeResponse[]> {
    return this.callToolOnAll<PreviewCreativeResponse>('preview_creative', params);
  }

  /**
   * Official AdCP get_creative_delivery tool schema (across multiple agents)
   */
  async getCreativeDelivery(params: GetCreativeDeliveryRequest): Promise<GetCreativeDeliveryResponse[]> {
    return this.callToolOnAll<GetCreativeDeliveryResponse>('get_creative_delivery', params);
  }

  /**
   * Official AdCP get_signals tool schema (across multiple agents)
   */
  async getSignals(params: GetSignalsRequest): Promise<GetSignalsResponse[]> {
    return this.callToolOnAll<GetSignalsResponse>('get_signals', params);
  }

  /**
   * Official AdCP activate_signal tool schema (across multiple agents)
   */
  async activateSignal(params: ActivateSignalRequest): Promise<ActivateSignalResponse[]> {
    return this.callToolOnAll<ActivateSignalResponse>('activate_signal', params);
  }

  /**
   * Official AdCP get_property_list tool schema (across multiple agents)
   */
  async getPropertyList(params: GetPropertyListRequest): Promise<GetPropertyListResponse[]> {
    return this.callToolOnAll<GetPropertyListResponse>('get_property_list', params);
  }

  /**
   * Official AdCP list_property_lists tool schema (across multiple agents)
   */
  async listPropertyLists(params: ListPropertyListsRequest): Promise<ListPropertyListsResponse[]> {
    return this.callToolOnAll<ListPropertyListsResponse>('list_property_lists', params);
  }

  /**
   * Official AdCP list_content_standards tool schema (across multiple agents)
   */
  async listContentStandards(params: ListContentStandardsRequest): Promise<ListContentStandardsResponse[]> {
    return this.callToolOnAll<ListContentStandardsResponse>('list_content_standards', params);
  }

  /**
   * Official AdCP get_content_standards tool schema (across multiple agents)
   */
  async getContentStandards(params: GetContentStandardsRequest): Promise<GetContentStandardsResponse[]> {
    return this.callToolOnAll<GetContentStandardsResponse>('get_content_standards', params);
  }

  /**
   * Official AdCP calibrate_content tool schema (across multiple agents)
   */
  async calibrateContent(params: CalibrateContentRequest): Promise<CalibrateContentResponse[]> {
    return this.callToolOnAll<CalibrateContentResponse>('calibrate_content', params);
  }

  /**
   * Official AdCP validate_content_delivery tool schema (across multiple agents)
   */
  async validateContentDelivery(params: ValidateContentDeliveryRequest): Promise<ValidateContentDeliveryResponse[]> {
    return this.callToolOnAll<ValidateContentDeliveryResponse>('validate_content_delivery', params);
  }

  /**
   * Official AdCP get_media_buy_artifacts tool schema (across multiple agents)
   */
  async getMediaBuyArtifacts(params: GetMediaBuyArtifactsRequest): Promise<GetMediaBuyArtifactsResponse[]> {
    return this.callToolOnAll<GetMediaBuyArtifactsResponse>('get_media_buy_artifacts', params);
  }

  /**
   * Official AdCP get_creative_features tool schema (across multiple agents)
   */
  async getCreativeFeatures(params: GetCreativeFeaturesRequest): Promise<GetCreativeFeaturesResponse[]> {
    return this.callToolOnAll<GetCreativeFeaturesResponse>('get_creative_features', params);
  }

  /**
   * Official AdCP si_get_offering tool schema (across multiple agents)
   */
  async siGetOffering(params: SIGetOfferingRequest): Promise<SIGetOfferingResponse[]> {
    return this.callToolOnAll<SIGetOfferingResponse>('si_get_offering', params);
  }

  /**
   * Official AdCP si_send_message tool schema (across multiple agents)
   */
  async siSendMessage(params: SISendMessageRequest): Promise<SISendMessageResponse[]> {
    return this.callToolOnAll<SISendMessageResponse>('si_send_message', params);
  }

  /**
   * Official AdCP get_adcp_capabilities tool schema (across multiple agents)
   */
  async getAdcpCapabilities(params: GetAdCPCapabilitiesRequest): Promise<GetAdCPCapabilitiesResponse[]> {
    return this.callToolOnAll<GetAdCPCapabilitiesResponse>('get_adcp_capabilities', params);
  }

  /**
   * Official AdCP list_accounts tool schema (across multiple agents)
   */
  async listAccounts(params: ListAccountsRequest): Promise<ListAccountsResponse[]> {
    return this.callToolOnAll<ListAccountsResponse>('list_accounts', params);
  }

  /**
   * Official AdCP sync_accounts tool schema (across multiple agents)
   */
  async syncAccounts(params: SyncAccountsRequest): Promise<SyncAccountsResponse[]> {
    return this.callToolOnAll<SyncAccountsResponse>('sync_accounts', params);
  }

}
