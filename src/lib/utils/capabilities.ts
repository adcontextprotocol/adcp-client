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
  | 'compliance_testing'
  | 'brand';

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
  supportedBilling: ('operator' | 'agent' | 'advertiser')[];

  /**
   * Default billing model applied when omitted from sync_accounts.
   */
  defaultBilling?: 'operator' | 'agent' | 'advertiser';

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
 * Idempotency capabilities declared by the seller.
 *
 * Clients MUST NOT fall back to an assumed TTL when the seller omits this —
 * `getIdempotencyReplayTtlSeconds()` throws when the declaration is missing
 * on a v3 server rather than silently defaulting to 24h. A seller without the
 * declaration is non-compliant and unsafe for retry-sensitive operations.
 */
export interface IdempotencyCapabilities {
  /**
   * Seconds the seller retains cached `(principal, idempotency_key, payload)`
   * tuples. BYOK callers compare their persisted key's age against this to
   * decide whether a fresh key + natural-key lookup is safer than reusing.
   */
  replayTtlSeconds: number;
}

/**
 * Normalized capabilities response that works for both v2 and v3 servers
 */
export interface AdcpCapabilities {
  /** Detected version ('v2' or 'v3') */
  version: 'v2' | 'v3';

  /**
   * Array of supported major versions (e.g., [2] or [2, 3]).
   * @deprecated Use {@link supportedVersions} for release-precision negotiation.
   * Removed in AdCP 4.0 per spec PR `adcontextprotocol/adcp#3493`. Continues
   * to be emitted alongside the new field through 3.x.
   */
  majorVersions: AdcpMajorVersion[];

  /**
   * Array of supported AdCP releases at release precision (`'3.0'`, `'3.1'`,
   * `'3.1.0-beta.1'`). Stable releases use `MAJOR.MINOR`; pre-releases use
   * the full pre-release tag. Set when the seller is on AdCP 3.1+ per spec
   * PR `adcontextprotocol/adcp#3493`. `undefined` on legacy 3.0-only sellers.
   */
  supportedVersions?: string[];

  /**
   * Full semver build of the seller's released AdCP version (e.g. `'3.1.2'`,
   * `'3.1.0-beta.1+sha.abc'`). Advisory — patch differences within the same
   * release-precision are non-breaking by spec convention. `undefined` on
   * legacy 3.0-only sellers.
   */
  buildVersion?: string;

  /** Supported protocols */
  protocols: AdcpProtocol[];

  /** Media buy specific features */
  features: MediaBuyFeatures;

  /** Account management capabilities */
  account?: AccountCapabilities;

  /** Creative protocol capabilities */
  creative?: CreativeCapabilities;

  /** Idempotency replay capabilities (v3 sellers declaring `adcp.idempotency`) */
  idempotency?: IdempotencyCapabilities;

  /** Supported extension namespaces (e.g., 'scope3', 'garm') */
  extensions: string[];

  /**
   * Experimental AdCP surfaces this agent implements. Dot-namespaced feature
   * ids (e.g. `brand.rights_lifecycle`, `governance.campaign`, `trusted_match.core`)
   * sellers declare when they opt into surfaces whose schemas carry
   * `x-status: experimental`. Consumers should gate any reliance on
   * experimental fields on presence of the matching id here.
   *
   * See https://adcontextprotocol.org/docs/reference/experimental-status
   */
  experimentalFeatures?: string[];

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
 * both MEDIA_BUY_TOOLS and CREATIVE_TOOLS). This is intentional — these tools
 * serve multiple domains, and their presence should activate all relevant
 * protocols when `detectProtocols()` runs.
 *
 * **Why these aren't manifest-derived (#1192).** The AdCP manifest
 * (`schemas/cache/{version}/manifest.json`) carries a single primary `protocol`
 * per tool — `list_creative_formats` is `media-buy` there, never `creative`.
 * That's an authoring convenience (where does the tool's spec page live), not
 * a capability-declaration semantic. The cross-listing here captures
 * operator reality: a CMP that exposes only `build_creative` /
 * `list_creative_formats` / `sync_creatives` IS a creative agent, and a buyer
 * discovering it via `tools/list` should see the `creative` protocol family.
 * Migrating to manifest-primary would silently flip `detectProtocols()`
 * results for cross-listed tools and break CMP↔DSP discovery flows. The
 * drift guard at `test/lib/capabilities-tools-drift.test.js` keeps the arrays
 * locked to recognized manifest tools (catches typos and removed-upstream
 * tools) without forcing the arrays to match the manifest's single-valued
 * view. See PR #1298 for the design rationale.
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
  // Collection list management (program-level brand safety)
  'create_collection_list',
  'update_collection_list',
  'get_collection_list',
  'list_collection_lists',
  'delete_collection_list',
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

// `creative_approval` is intentionally absent — it's webhook-only (the buyer
// POSTs to the `approval_webhook` URL returned by `acquire_rights`), not an
// MCP/A2A tool the seller exposes. Adopters wire it via their HTTP server
// using `BrandRightsPlatform.reviewCreativeApproval`.
export const BRAND_RIGHTS_TOOLS = ['get_brand_identity', 'get_rights', 'acquire_rights', 'update_rights'] as const;

export const EVENT_TRACKING_TOOLS = ['sync_event_sources', 'log_event'] as const;

export const ACCOUNT_TOOLS = ['list_accounts', 'sync_accounts'] as const;

export const PROTOCOL_TOOLS = ['get_adcp_capabilities'] as const;

/**
 * Build synthetic capabilities from a list of available tools.
 * Used for v2 servers that don't support get_adcp_capabilities.
 */
/**
 * Tool-group → protocol mapping for detection from tools/list.
 */
const TOOL_PROTOCOL_MAP: [readonly string[], AdcpProtocol][] = [
  [MEDIA_BUY_TOOLS, 'media_buy'],
  [SIGNALS_TOOLS, 'signals'],
  [GOVERNANCE_TOOLS, 'governance'],
  [CREATIVE_TOOLS, 'creative'],
  [SPONSORED_INTELLIGENCE_TOOLS, 'sponsored_intelligence'],
  [TRUSTED_MATCH_TOOLS, 'trusted_match'],
  [COMPLIANCE_TOOLS, 'compliance_testing'],
  [BRAND_RIGHTS_TOOLS, 'brand'],
];

/**
 * Detect protocols from tool names.
 */
function detectProtocolsFromTools(toolNames: Set<string>): AdcpProtocol[] {
  const protocols: AdcpProtocol[] = [];
  for (const [tools, protocol] of TOOL_PROTOCOL_MAP) {
    if (tools.some(t => toolNames.has(t))) {
      protocols.push(protocol);
    }
  }
  return protocols;
}

/**
 * Augment declared capabilities with compliance_testing if the tool is present
 * but no `compliance_testing` capability block / protocol entry was advertised.
 *
 * Per AdCP 3.0, agents declare comply_test_controller support via the
 * top-level `capabilities.compliance_testing` block. `parseCapabilitiesResponse`
 * already promotes that block into the internal `protocols` list, so if we
 * reach this function with the tool present but the protocol missing, the
 * agent forgot the declaration. We auto-bridge (the SDK's internal type can
 * treat the agent as compliance-capable) and warn the agent once so they can
 * ship the proper block.
 *
 * Other protocols (media_buy, signals, etc.) are NOT augmented because a stub
 * or partial tool registration could produce false positives.
 */
export function augmentCapabilitiesFromTools(capabilities: AdcpCapabilities, tools: ToolInfo[]): AdcpCapabilities {
  const toolNames = new Set(tools.map(t => t.name));
  const hasComplianceTool = COMPLIANCE_TOOLS.some(t => toolNames.has(t));
  if (!hasComplianceTool || capabilities.protocols.includes('compliance_testing')) {
    return capabilities;
  }
  console.error(
    `[AdCP] Agent exposes comply_test_controller but omits the \`compliance_testing\` capability block ` +
      `from get_adcp_capabilities. Per AdCP 3.0, declare \`capabilities.compliance_testing.scenarios\` ` +
      `— not \`supported_protocols\`. The SDK is treating the agent as compliance-capable for this request.`
  );
  return {
    ...capabilities,
    protocols: [...capabilities.protocols, 'compliance_testing'],
  };
}

export function buildSyntheticCapabilities(tools: ToolInfo[]): AdcpCapabilities {
  const toolNames = new Set(tools.map(t => t.name));
  const protocols = detectProtocolsFromTools(toolNames);

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
 * Build synthetic v3 capabilities when the agent advertises
 * `get_adcp_capabilities` (a v3-only tool) but the call itself failed —
 * either the executor threw, or the response was non-success with no
 * structurally v3-shaped data (the case `looksLikeV3Capabilities` would
 * have caught).
 *
 * The agent is verifiably v3 because the v3-only discovery tool is
 * present in `tools/list`. Falling back to v2 synthetic in this case
 * triggers v2.5-schema lookups that have nothing to do with the original
 * failure, cascading "AdCP schema data for version v2.5 not found"
 * across every subsequent step. Treating as v3 (synthetic) lets the
 * caller continue against the right adapter set; the underlying
 * `get_adcp_capabilities` failure still surfaces in logs at the
 * call site.
 *
 * Sets `_synthetic: true` so version-compat checks know detail-level
 * fields (idempotency TTL, supportedVersions) are unknown — callers
 * skip those checks rather than throw `VersionUnsupportedError` on a
 * verifiably-v3 agent.
 *
 * Refs: #1217 (carve-out from #1197/closed), #1189 / #1201 (the v3-shape
 * heuristic this complements).
 */
export function buildSyntheticV3Capabilities(tools: ToolInfo[]): AdcpCapabilities {
  const toolNames = new Set(tools.map(t => t.name));
  const protocols = detectProtocolsFromTools(toolNames);

  const features: MediaBuyFeatures = {
    inlineCreativeManagement: toolNames.has('sync_creatives'),
    propertyListFiltering: false,
    contentStandards: false,
    conversionTracking: EVENT_TRACKING_TOOLS.some(t => toolNames.has(t)),
    audienceTargeting: toolNames.has('sync_audiences'),
  };

  return {
    version: 'v3',
    majorVersions: [3],
    protocols,
    features,
    extensions: [],
    _synthetic: true,
  };
}

/**
 * Heuristic: does this `get_adcp_capabilities` response look v3-shaped?
 *
 * Used by callers (e.g. SingleAgentClient.getCapabilities) when the response
 * fails strict schema validation but is structurally non-empty. The question
 * the heuristic answers is "is this a v3 agent with a wire-shape bug, or a
 * v2 agent that happens to advertise the tool?". Falling back to v2 in the
 * former case masks the original bug behind cascading v2.5-schema-not-found
 * errors; treating it as v3 surfaces the wire-shape bug at its source.
 *
 * Affirmative v3 signals (any one is enough):
 *   - `adcp` block (only v3 servers carry the `{ major_versions, idempotency, ... }` envelope)
 *   - `supported_protocols` array (v3-only top-level field)
 *   - any v3 protocol-level capability block (`media_buy`, `signals`, `creative`, `brand`,
 *     `governance`, `sponsored_intelligence`, `compliance_testing`, `account`)
 *
 * v2 servers don't expose `get_adcp_capabilities` at all (the tool itself is
 * a v3-only addition), so reaching this function with a non-empty payload
 * already strongly implies v3 — but we belt-and-suspenders the structural
 * check to avoid mis-promoting genuinely empty / null responses.
 */
export function looksLikeV3Capabilities(data: unknown): boolean {
  if (!isPlainObject(data)) return false;
  if (isPlainObject(data.adcp)) return true;
  if (Array.isArray(data.supported_protocols)) return true;
  const v3Blocks = [
    'account',
    'media_buy',
    'signals',
    'creative',
    'brand',
    'governance',
    'sponsored_intelligence',
    'compliance_testing',
  ] as const;
  return v3Blocks.some(block => isPlainObject(data[block]));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parse a get_adcp_capabilities response into normalized form
 */
export function parseCapabilitiesResponse(response: any): AdcpCapabilities {
  const majorVersions = (response.adcp?.major_versions ?? [2]) as AdcpMajorVersion[];
  const highestVersion = Math.max(...majorVersions) as AdcpMajorVersion;

  // AdCP 3.1+ release-precision capability fields per spec PR
  // `adcontextprotocol/adcp#3493`. Both fields are optional during the 3.x
  // SHOULD-emit phase; legacy 3.0 sellers won't carry them. Filter
  // `supported_versions` to strings — a misbehaving seller emitting
  // `['3.0', 42, null]` shouldn't poison the typed array. Match the
  // filtering that `extractVersionUnsupportedDetails` already does so the
  // two seller-input surfaces have the same safety contract.
  const supportedVersions = Array.isArray(response.adcp?.supported_versions)
    ? (response.adcp.supported_versions as unknown[]).filter((v): v is string => typeof v === 'string')
    : undefined;
  const buildVersion = typeof response.adcp?.build_version === 'string' ? response.adcp.build_version : undefined;

  // Per AdCP 3.0, `compliance_testing` is declared as a top-level
  // capability block, not as a value in `supported_protocols`. Normalize
  // legacy callers (who grep for `protocols.includes('compliance_testing')`)
  // by promoting the block into the protocols list at parse time — the
  // internal `AdcpCapabilities.protocols` shape is the SDK's own normalization
  // and doesn't need to match the wire.
  const wireProtocols = (response.supported_protocols ?? []) as AdcpProtocol[];
  const protocols =
    response.compliance_testing && !wireProtocols.includes('compliance_testing' as AdcpProtocol)
      ? ([...wireProtocols, 'compliance_testing'] as AdcpProtocol[])
      : wireProtocols;

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

  // adcp.idempotency.replay_ttl_seconds is REQUIRED per spec when the seller
  // supports mutating tools. Absence is surfaced downstream as a fail-closed
  // error in getIdempotencyReplayTtlSeconds() — we deliberately do NOT default.
  let idempotency: IdempotencyCapabilities | undefined;
  const rawTtl = response.adcp?.idempotency?.replay_ttl_seconds;
  if (typeof rawTtl === 'number' && Number.isFinite(rawTtl) && rawTtl > 0) {
    idempotency = { replayTtlSeconds: rawTtl };
  }

  return {
    version: highestVersion >= 3 ? 'v3' : 'v2',
    majorVersions,
    supportedVersions,
    buildVersion,
    protocols,
    features,
    account,
    creative,
    idempotency,
    extensions: response.extensions_supported ?? [],
    experimentalFeatures: Array.isArray(response.experimental_features)
      ? response.experimental_features.filter((f: unknown): f is string => typeof f === 'string')
      : undefined,
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
 * Check if the agent has opted into a specific experimental AdCP surface.
 *
 * Experimental surfaces carry `x-status: experimental` in the spec and their
 * fields may change between minor releases. Consumers should gate any
 * reliance on experimental fields on a positive check here.
 *
 * @param capabilities — normalized capabilities from `parseCapabilitiesResponse`
 * @param featureId — dot-namespaced id (e.g. `brand.rights_lifecycle`)
 *
 * @example
 * ```ts
 * if (supportsExperimentalFeature(caps, 'brand.rights_lifecycle')) {
 *   // safe to call acquire_rights / release_rights and read their responses
 * }
 * ```
 */
export function supportsExperimentalFeature(capabilities: AdcpCapabilities, featureId: string): boolean {
  return capabilities.experimentalFeatures?.includes(featureId) ?? false;
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
  comply_test_controller: ['compliance_testing'],

  // Brand rights protocol
  get_brand_identity: ['brand'],
  get_rights: ['brand'],
  acquire_rights: ['brand'],
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

  // Experimental-surface check (e.g., 'experimental:brand.rights_lifecycle')
  if (feature.startsWith('experimental:')) {
    const featureId = feature.slice('experimental:'.length);
    return supportsExperimentalFeature(capabilities, featureId);
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

  // Experimental surfaces
  for (const id of capabilities.experimentalFeatures ?? []) {
    features.push(`experimental:${id}`);
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
