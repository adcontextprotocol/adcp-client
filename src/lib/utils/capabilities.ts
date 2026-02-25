/**
 * AdCP Capabilities utilities
 *
 * Provides types and helpers for working with agent capabilities,
 * including synthetic capabilities for v2 servers that don't support
 * the get_adcp_capabilities tool.
 */

/**
 * Detected AdCP major version
 */
export type AdcpMajorVersion = 2 | 3;

/**
 * Supported AdCP protocols/domains
 */
export type AdcpProtocol = 'media_buy' | 'signals' | 'governance' | 'creative' | 'sponsored_intelligence';

/**
 * Media buy features available on the agent
 */
export interface MediaBuyFeatures {
  /** Agent supports inline creative upload in create/update_media_buy */
  inlineCreativeManagement?: boolean;
  /** Agent supports property_list filtering in get_products */
  propertyListFiltering?: boolean;
  /** Agent supports content standards validation */
  contentStandards?: boolean;
  /** Agent supports conversion event tracking (sync_event_sources, log_event) */
  conversionTracking?: boolean;
  /** Agent supports first-party CRM audience management (sync_audiences) */
  audienceManagement?: boolean;
}

/**
 * Account management capabilities declared by the seller
 */
export interface AccountCapabilities {
  /**
   * Whether the seller requires operator-level credentials.
   * When false (default), the agent authenticates once and declares brands/operators via sync_accounts.
   * When true, each operator must authenticate independently.
   */
  requireOperatorAuth: boolean;

  /**
   * OAuth authorization endpoint for obtaining operator-level credentials.
   * Present when require_operator_auth is true and the seller supports OAuth.
   */
  authorizationEndpoint?: string;

  /**
   * Billing models this seller supports (e.g., 'operator', 'agent').
   */
  supportedBilling: ('brand' | 'operator' | 'agent')[];

  /**
   * Default billing model applied when omitted from sync_accounts.
   */
  defaultBilling?: 'brand' | 'operator' | 'agent';

  /**
   * Whether an active account is required before calling get_products.
   */
  requiredForProducts: boolean;
}

/**
 * Normalized capabilities response that works for both v2 and v3 servers
 */
export interface AdcpCapabilities {
  /** Detected version ('v2' or 'v3') */
  version: 'v2' | 'v3';

  /** Array of supported major versions (e.g., [2] or [2, 3]) */
  majorVersions: AdcpMajorVersion[];

  /** Supported protocols */
  protocols: AdcpProtocol[];

  /** Media buy specific features */
  features: MediaBuyFeatures;

  /** Account management capabilities */
  account?: AccountCapabilities;

  /** Supported extension namespaces (e.g., 'scope3', 'garm') */
  extensions: string[];

  /** Publisher domains covered by this agent */
  publisherDomains?: string[];

  /** Supported advertising channels */
  channels?: string[];

  /** Last updated timestamp (if provided by server) */
  lastUpdated?: string;

  /** Whether this was synthesized from tool list (v2) or from get_adcp_capabilities (v3) */
  _synthetic: boolean;

  /** Raw response from get_adcp_capabilities (only for v3) */
  _raw?: unknown;
}

/**
 * Tool info for capability detection
 */
export interface ToolInfo {
  name: string;
  description?: string;
}

/**
 * Known AdCP tool names for protocol detection.
 * These map to task names in the AdCP schema index (kebab-case -> snake_case).
 *
 * Note: Some tools appear in multiple arrays (e.g., list_creative_formats is in
 * both MEDIA_BUY_TOOLS and CREATIVE_TOOLS). This is intentional - these tools
 * serve multiple domains, and their presence should activate all relevant protocols.
 */
export const MEDIA_BUY_TOOLS = [
  'get_products',
  'list_creative_formats', // Also in CREATIVE_TOOLS - serves both domains
  'create_media_buy',
  'update_media_buy',
  'sync_creatives',
  'list_creatives',
  'get_media_buy_delivery',
  'provide_performance_feedback',
  'sync_audiences',
] as const;

export const SIGNALS_TOOLS = ['get_signals', 'activate_signal'] as const;

export const GOVERNANCE_TOOLS = [
  // Property list management
  'create_property_list',
  'update_property_list',
  'get_property_list',
  'list_property_lists',
  'delete_property_list',
  // Content standards
  'list_content_standards',
  'get_content_standards',
  'create_content_standards',
  'update_content_standards',
  'calibrate_content',
  'validate_content_delivery',
  'get_media_buy_artifacts',
] as const;

export const CREATIVE_TOOLS = ['build_creative', 'list_creative_formats', 'preview_creative'] as const;

export const SPONSORED_INTELLIGENCE_TOOLS = [
  'si_get_offering',
  'si_initiate_session',
  'si_send_message',
  'si_terminate_session',
] as const;

export const EVENT_TRACKING_TOOLS = ['sync_event_sources', 'log_event'] as const;

export const ACCOUNT_TOOLS = ['list_accounts', 'sync_accounts'] as const;

export const PROTOCOL_TOOLS = ['get_adcp_capabilities'] as const;

/**
 * Build synthetic capabilities from a list of available tools.
 * Used for v2 servers that don't support get_adcp_capabilities.
 */
export function buildSyntheticCapabilities(tools: ToolInfo[]): AdcpCapabilities {
  const toolNames = new Set(tools.map(t => t.name));

  // Detect supported protocols from available tools
  const protocols: AdcpProtocol[] = [];

  const hasMediaBuyTools = MEDIA_BUY_TOOLS.some(t => toolNames.has(t));
  if (hasMediaBuyTools) {
    protocols.push('media_buy');
  }

  const hasSignalsTools = SIGNALS_TOOLS.some(t => toolNames.has(t));
  if (hasSignalsTools) {
    protocols.push('signals');
  }

  const hasGovernanceTools = GOVERNANCE_TOOLS.some(t => toolNames.has(t));
  if (hasGovernanceTools) {
    protocols.push('governance');
  }

  const hasCreativeTools = CREATIVE_TOOLS.some(t => toolNames.has(t));
  if (hasCreativeTools) {
    protocols.push('creative');
  }

  const hasSponsoredIntelligenceTools = SPONSORED_INTELLIGENCE_TOOLS.some(t => toolNames.has(t));
  if (hasSponsoredIntelligenceTools) {
    protocols.push('sponsored_intelligence');
  }

  // Detect features from tool presence
  const features: MediaBuyFeatures = {
    // v2 servers support inline creative management if they have sync_creatives
    inlineCreativeManagement: toolNames.has('sync_creatives'),
    // Property list filtering is v3 only
    propertyListFiltering: false,
    // Content standards is v3 only
    contentStandards: false,
    // Conversion tracking if event tracking tools are available
    conversionTracking: EVENT_TRACKING_TOOLS.some(t => toolNames.has(t)),
    // Audience management if sync_audiences is available
    audienceManagement: toolNames.has('sync_audiences'),
  };

  return {
    version: 'v2',
    majorVersions: [2],
    protocols,
    features,
    extensions: [],
    _synthetic: true,
  };
}

/**
 * Parse a get_adcp_capabilities response into normalized form
 */
export function parseCapabilitiesResponse(response: any): AdcpCapabilities {
  const majorVersions = (response.adcp?.major_versions ?? [2]) as AdcpMajorVersion[];
  const highestVersion = Math.max(...majorVersions) as AdcpMajorVersion;

  const protocols = (response.supported_protocols ?? []) as AdcpProtocol[];

  const features: MediaBuyFeatures = {
    inlineCreativeManagement: response.media_buy?.features?.inline_creative_management ?? false,
    propertyListFiltering: response.media_buy?.features?.property_list_filtering ?? false,
    contentStandards: response.media_buy?.features?.content_standards ?? false,
    conversionTracking: response.media_buy?.features?.conversion_tracking ?? false,
    audienceManagement: response.media_buy?.features?.audience_management ?? false,
  };

  let account: AccountCapabilities | undefined;
  if (response.account) {
    account = {
      requireOperatorAuth: response.account.require_operator_auth ?? false,
      authorizationEndpoint: response.account.authorization_endpoint,
      supportedBilling: response.account.supported_billing ?? [],
      defaultBilling: response.account.default_billing,
      requiredForProducts: response.account.required_for_products ?? false,
    };
  }

  return {
    version: highestVersion >= 3 ? 'v3' : 'v2',
    majorVersions,
    protocols,
    features,
    account,
    extensions: response.extensions_supported ?? [],
    publisherDomains: response.media_buy?.portfolio?.publisher_domains,
    channels: response.media_buy?.portfolio?.channels,
    lastUpdated: response.last_updated,
    _synthetic: false,
    _raw: response,
  };
}

/**
 * Check if capabilities indicate v3 support
 */
export function supportsV3(capabilities: AdcpCapabilities): boolean {
  return capabilities.majorVersions.includes(3);
}

/**
 * Check if a specific protocol is supported
 */
export function supportsProtocol(capabilities: AdcpCapabilities, protocol: AdcpProtocol): boolean {
  return capabilities.protocols.includes(protocol);
}

/**
 * Check if property list filtering is supported (v3 feature)
 */
export function supportsPropertyListFiltering(capabilities: AdcpCapabilities): boolean {
  return capabilities.features.propertyListFiltering ?? false;
}

/**
 * Check if content standards are supported (v3 feature)
 */
export function supportsContentStandards(capabilities: AdcpCapabilities): boolean {
  return capabilities.features.contentStandards ?? false;
}
