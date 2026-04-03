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
export type AdcpProtocol =
  | 'media_buy'
  | 'signals'
  | 'governance'
  | 'creative'
  | 'sponsored_intelligence'
  | 'trusted_match'
  | 'compliance';

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
  audienceTargeting?: boolean;
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
   * Present when the seller supports OAuth for operator authentication.
   * May be absent even when requireOperatorAuth is true — in that case,
   * operators obtain credentials out-of-band (e.g., seller portal, API key).
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

  /**
   * Whether the seller supports sandbox accounts for testing.
   * For implicit accounts (require_operator_auth: false), declare sandbox via sync_accounts
   * with sandbox: true and reference by natural key. For explicit accounts
   * (require_operator_auth: true), discover pre-existing test accounts via list_accounts.
   */
  sandbox: boolean;
}

/**
 * Creative protocol capabilities declared by the agent.
 */
export interface CreativeCapabilities {
  /** Agent can validate compliance requirements while building creatives */
  supportsCompliance: boolean;
  /** Agent exposes a creative library addressable via creative_id */
  hasCreativeLibrary: boolean;
  /** Agent can generate creatives from a natural-language brief */
  supportsGeneration: boolean;
  /** Agent can adapt an existing creative to a new format */
  supportsTransformation: boolean;
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

  /** Creative protocol capabilities */
  creative?: CreativeCapabilities;

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
  _raw?: Record<string, unknown>;
}

/**
 * Safely traverse nested keys in a Record<string, unknown>.
 */
function getRawNested(obj: Record<string, unknown> | undefined, ...keys: string[]): unknown {
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
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
  'list_creatives', // Also in CREATIVE_TOOLS - serves both domains
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
  // Campaign governance
  'sync_plans',
  'check_governance',
  'report_plan_outcome',
  'get_plan_audit_logs',
  // Creative governance
  'get_creative_features',
] as const;

export const CREATIVE_TOOLS = [
  'build_creative',
  'list_creative_formats',
  'preview_creative',
  'list_creatives',
  'sync_creatives', // Also in MEDIA_BUY_TOOLS - serves both domains
] as const;

export const SPONSORED_INTELLIGENCE_TOOLS = [
  'si_get_offering',
  'si_initiate_session',
  'si_send_message',
  'si_terminate_session',
] as const;

export const TRUSTED_MATCH_TOOLS = ['context_match', 'identity_match'] as const;

export const COMPLIANCE_TOOLS = ['comply_test_controller'] as const;

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

  const hasTrustedMatchTools = TRUSTED_MATCH_TOOLS.some(t => toolNames.has(t));
  if (hasTrustedMatchTools) {
    protocols.push('trusted_match');
  }

  const hasComplianceTools = COMPLIANCE_TOOLS.some(t => toolNames.has(t));
  if (hasComplianceTools) {
    protocols.push('compliance');
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
    // Audience targeting if sync_audiences is available
    audienceTargeting: toolNames.has('sync_audiences'),
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
    audienceTargeting: response.media_buy?.features?.audience_targeting ?? false,
  };

  let account: AccountCapabilities | undefined;
  if (response.account) {
    account = {
      requireOperatorAuth: response.account.require_operator_auth ?? false,
      authorizationEndpoint: response.account.authorization_endpoint,
      supportedBilling: response.account.supported_billing ?? [],
      defaultBilling: response.account.default_billing,
      requiredForProducts: response.account.required_for_products ?? false,
      sandbox: response.account.sandbox ?? false,
    };
  }

  let creative: CreativeCapabilities | undefined;
  if (response.creative) {
    creative = {
      supportsCompliance: response.creative.supports_compliance ?? false,
      hasCreativeLibrary: response.creative.has_creative_library ?? false,
      supportsGeneration: response.creative.supports_generation ?? false,
      supportsTransformation: response.creative.supports_transformation ?? false,
    };
  }

  return {
    version: highestVersion >= 3 ? 'v3' : 'v2',
    majorVersions,
    protocols,
    features,
    account,
    creative,
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

/**
 * Check if the seller requires per-operator authentication
 */
export function requiresOperatorAuth(capabilities: AdcpCapabilities): boolean {
  return capabilities.account?.requireOperatorAuth ?? false;
}

/**
 * Check if an active account is required before calling get_products
 */
export function requiresAccountForProducts(capabilities: AdcpCapabilities): boolean {
  return capabilities.account?.requiredForProducts ?? false;
}

/**
 * Check if the seller supports sandbox accounts
 */
export function supportsSandbox(capabilities: AdcpCapabilities): boolean {
  return capabilities.account?.sandbox ?? false;
}

/**
 * Feature name that can be checked via supports()/require().
 *
 * Supported namespaces:
 * - Plain names resolve to media_buy.features (e.g., 'audience_targeting')
 * - 'media_buy', 'signals', etc. check supported_protocols
 * - 'ext:<name>' checks extensions_supported (e.g., 'ext:scope3')
 * - 'targeting.<name>' checks media_buy.execution.targeting (e.g., 'targeting.geo_countries')
 */
export type FeatureName = string;

/**
 * Map of task names to features they require.
 *
 * When validateFeatures is enabled (default), SingleAgentClient checks
 * these features against seller capabilities before sending a request.
 * Tasks not listed here have no feature requirements.
 */
export const TASK_FEATURE_MAP: Record<string, FeatureName[]> = {
  // Core media buy tasks require the media_buy protocol
  get_products: ['media_buy'],
  // list_creative_formats intentionally omitted — serves both media-buy and creative domains
  create_media_buy: ['media_buy'],
  update_media_buy: ['media_buy'],
  get_media_buys: ['media_buy'],
  get_media_buy_delivery: ['media_buy'],
  provide_performance_feedback: ['media_buy'],

  // sync_creatives intentionally omitted — serves both media-buy and creative domains
  // list_creatives intentionally omitted — serves both media-buy and creative domains

  // Audience management
  sync_audiences: ['media_buy', 'audience_targeting'],

  // Event tracking / conversion
  sync_event_sources: ['media_buy', 'conversion_tracking'],
  log_event: ['media_buy', 'conversion_tracking'],

  // Signals protocol
  get_signals: ['signals'],
  activate_signal: ['signals'],

  // Creative protocol
  build_creative: ['creative'],
  preview_creative: ['creative'],

  // Governance protocol
  create_property_list: ['governance'],
  update_property_list: ['governance'],
  get_property_list: ['governance'],
  list_property_lists: ['governance'],
  delete_property_list: ['governance'],
  list_content_standards: ['governance', 'content_standards'],
  get_content_standards: ['governance', 'content_standards'],
  create_content_standards: ['governance', 'content_standards'],
  update_content_standards: ['governance', 'content_standards'],
  calibrate_content: ['governance', 'content_standards'],
  validate_content_delivery: ['governance', 'content_standards'],
  get_media_buy_artifacts: ['governance'],

  // Campaign governance
  sync_plans: ['governance'],
  check_governance: ['governance'],
  report_plan_outcome: ['governance'],
  get_plan_audit_logs: ['governance'],

  // Creative governance
  get_creative_features: ['governance'],

  // Sponsored intelligence protocol
  si_get_offering: ['sponsored_intelligence'],
  si_initiate_session: ['sponsored_intelligence'],
  si_send_message: ['sponsored_intelligence'],
  si_terminate_session: ['sponsored_intelligence'],

  // Trusted match protocol
  context_match: ['trusted_match'],
  identity_match: ['trusted_match'],

  // Compliance protocol
  comply_test_controller: ['compliance'],
};

/**
 * Map of media_buy.features field names to their camelCase keys in MediaBuyFeatures.
 */
const FEATURE_KEY_MAP: Record<string, keyof MediaBuyFeatures> = {
  inline_creative_management: 'inlineCreativeManagement',
  property_list_filtering: 'propertyListFiltering',
  content_standards: 'contentStandards',
  conversion_tracking: 'conversionTracking',
  audience_targeting: 'audienceTargeting',
  audience_management: 'audienceTargeting', // legacy alias
};

/**
 * Resolve whether a single feature is supported by the given capabilities.
 *
 * Absent = unsupported (returns false).
 */
export function resolveFeature(capabilities: AdcpCapabilities, feature: FeatureName): boolean {
  // Protocol-level check (e.g., 'media_buy', 'signals')
  if (capabilities.protocols.includes(feature as AdcpProtocol)) {
    return true;
  }

  // Extension check (e.g., 'ext:scope3')
  if (feature.startsWith('ext:')) {
    const extName = feature.slice(4);
    return capabilities.extensions.includes(extName);
  }

  // Targeting check (e.g., 'targeting.geo_countries')
  if (feature.startsWith('targeting.')) {
    const targetingKey = feature.slice(10);
    const targeting = getRawNested(capabilities._raw, 'media_buy', 'execution', 'targeting');
    if (!targeting || typeof targeting !== 'object') return false;
    return !!(targeting as Record<string, unknown>)[targetingKey];
  }

  // Media buy features (e.g., 'audience_targeting', 'conversion_tracking')
  const featureKey = FEATURE_KEY_MAP[feature];
  if (featureKey) {
    return capabilities.features[featureKey] ?? false;
  }

  // Check raw media_buy.features for features not in the normalized map
  const rawFeatures = getRawNested(capabilities._raw, 'media_buy', 'features');
  if (rawFeatures && typeof rawFeatures === 'object' && feature in rawFeatures) {
    return !!(rawFeatures as Record<string, unknown>)[feature];
  }

  // Unknown feature — absent means unsupported
  return false;
}

/**
 * List all declared feature names from capabilities (for error messages).
 */
export function listDeclaredFeatures(capabilities: AdcpCapabilities): string[] {
  const features: string[] = [];

  // Protocols
  for (const p of capabilities.protocols) {
    features.push(p);
  }

  // Media buy features
  for (const [snakeKey, camelKey] of Object.entries(FEATURE_KEY_MAP)) {
    if (capabilities.features[camelKey]) {
      features.push(snakeKey);
    }
  }

  // Extensions
  for (const ext of capabilities.extensions) {
    features.push(`ext:${ext}`);
  }

  // Targeting (from raw response)
  const targeting = getRawNested(capabilities._raw, 'media_buy', 'execution', 'targeting');
  if (targeting && typeof targeting === 'object') {
    for (const [key, value] of Object.entries(targeting)) {
      if (value === true || (typeof value === 'object' && value !== null)) {
        features.push(`targeting.${key}`);
      }
    }
  }

  return [...new Set(features)];
}
