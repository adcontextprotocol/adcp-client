// AdCP Types - Based on official AdCP specification
// https://adcontextprotocol.org/docs/reference/data-models

/**
 * Protocol-level fields that bypass per-tool schema stripping.
 * These fields live at the AdCP envelope layer, not in individual tool schemas,
 * and must always be preserved when sending requests to agents.
 */
export const ADCP_ENVELOPE_FIELDS = new Set([
  'adcp_major_version', // Protocol version negotiation — preserved so version probes reach the seller
  'context', // Opaque pass-through for correlation and workflow state
  'ext', // Vendor-namespaced extensions
  'governance_context', // Governance approval token
  'push_notification_config', // Webhook configuration for async operations
  'context_id', // Legacy context identifier
  'idempotency_key', // Prevents duplicate processing on retries
]);

// Import structured FormatID from generated core types. AdCP 3.0.1 renamed
// the schema title to "Format Reference (Structured Object)" — wire shape
// unchanged; we keep the local `FormatID` name via the `as` alias.
import type {
  CreateMediaBuyAsyncInputRequired,
  CreateMediaBuyAsyncSubmitted,
  CreateMediaBuyAsyncWorking,
  FormatReferenceStructuredObject as FormatID,
  FrequencyCap,
  CreateMediaBuyResponse,
  GetProductsResponse,
  GetProductsAsyncWorking,
  GetProductsAsyncInputRequired,
  GetProductsAsyncSubmitted,
  UpdateMediaBuyResponse,
  UpdateMediaBuyAsyncWorking,
  UpdateMediaBuyAsyncInputRequired,
  UpdateMediaBuyAsyncSubmitted,
  SyncCreativesAsyncWorking,
  SyncCreativesAsyncInputRequired,
  SyncCreativesAsyncSubmitted,
  SyncCreativesResponse,
} from './core.generated';

import type { SigningProvider } from '../signing/provider';

export type { FrequencyCap } from './core.generated';

export interface MediaBuy {
  id: string;
  campaign_name?: string;
  advertiser_name?: string;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  /** Total budget amount (currency determined by pricing options) */
  total_budget: number;
  targeting: Targeting;
  creative_assets: CreativeAsset[];
  delivery_schedule: DeliverySchedule;
  created_at: string;
  updated_at: string;
}

export interface CreativeAsset {
  id: string;
  name: string;
  type: 'image' | 'video' | 'html' | 'native';
  format: string;
  dimensions: {
    width: number;
    height: number;
  };
  // Support for both hosted and third-party assets
  url?: string; // For backward compatibility (deprecated)
  media_url?: string; // Hosted asset URL
  snippet?: string; // Third-party asset snippet
  snippet_type?: 'html' | 'javascript' | 'amp';
  status: 'active' | 'inactive' | 'pending_review' | 'approved' | 'rejected';
  file_size?: number;
  duration?: number;
  // Enhanced metadata
  tags?: string[];
  sub_assets?: CreativeSubAsset[];
  created_at?: string;
  updated_at?: string;
}

export interface CreativeSubAsset {
  id: string;
  name: string;
  type: 'companion' | 'thumbnail' | 'preview';
  media_url: string;
  dimensions?: {
    width: number;
    height: number;
  };
}

export interface AdvertisingProduct {
  id: string;
  name: string;
  description: string;
  type: 'display' | 'video' | 'native' | 'audio' | 'connected_tv';
  pricing_model: 'cpm' | 'cpc' | 'cpa' | 'fixed';
  base_price: number;
  currency: string;
  minimum_spend?: number;
  targeting_capabilities: string[];
  creative_formats: CreativeFormat[];
  inventory_details: InventoryDetails;
}

export interface CreativeFormat {
  format_id: FormatID;
  name: string;
  dimensions: {
    width: number;
    height: number;
  };
  aspect_ratio?: string;
  file_types: string[];
  max_file_size: number;
  duration_range?: {
    min: number;
    max: number;
  };
}

export interface InventoryDetails {
  sources: string[];
  quality_score?: number;
  brand_safety_level?: 'high' | 'medium' | 'low';
  viewability_rate?: number;
  geographic_coverage: string[];
}

export interface Targeting {
  geographic?: GeographicTargeting;
  demographic?: DemographicTargeting;
  behavioral?: BehavioralTargeting;
  contextual?: ContextualTargeting;
  device?: DeviceTargeting;
  frequency_cap?: FrequencyCap;
}

export interface GeographicTargeting {
  countries?: string[];
  regions?: string[];
  cities?: string[];
  postal_codes?: string[];
}

export interface DemographicTargeting {
  age_ranges?: {
    min: number;
    max: number;
  }[];
  genders?: ('male' | 'female' | 'other')[];
  income_ranges?: {
    min: number;
    max: number;
    currency: string;
  }[];
}

export interface BehavioralTargeting {
  interests?: string[];
  purchase_intent?: string[];
  life_events?: string[];
}

export interface ContextualTargeting {
  keywords?: string[];
  topics?: string[];
  content_categories?: string[];
  website_categories?: string[];
}

export interface DeviceTargeting {
  device_types?: ('mobile' | 'tablet' | 'desktop' | 'connected_tv')[];
  operating_systems?: string[];
  browsers?: string[];
}

export interface DeliverySchedule {
  start_date: string;
  end_date?: string;
  time_zone: string;
  day_parting?: DayParting[];
}

export interface DayParting {
  days_of_week: ('monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday')[];
  hours: {
    start: number;
    end: number;
  };
}

/**
 * OAuth tokens for agent authentication
 */
export interface AgentOAuthTokens {
  /** OAuth access token */
  access_token: string;
  /** OAuth refresh token (for token renewal) */
  refresh_token?: string;
  /** Token type (usually "Bearer") */
  token_type?: string;
  /** Seconds until access_token expires */
  expires_in?: number;
  /** ISO timestamp when access_token expires */
  expires_at?: string;
  /** OAuth scope */
  scope?: string;
}

/**
 * OAuth client information (from dynamic registration)
 */
export interface AgentOAuthClient {
  /** OAuth client ID */
  client_id: string;
  /** OAuth client secret (for confidential clients) */
  client_secret?: string;
  /** When client_secret expires */
  client_secret_expires_at?: number;
}

/**
 * OAuth 2.0 client credentials grant configuration (RFC 6749 §4.4).
 *
 * For machine-to-machine authentication where no user is present — the
 * library exchanges the client ID + secret directly with the authorization
 * server. Tokens are cached in `AgentConfig.oauth_tokens` and re-exchanged
 * by `ensureClientCredentialsTokens` when they near expiry.
 *
 * Secret values (`client_id`, `client_secret`) may be either literal strings
 * or env-var references in the form `$ENV:VAR_NAME`. References are resolved
 * at token-exchange time by `resolveSecret`, so secrets never need to land
 * on disk for CI use cases.
 *
 * @example Literal secret (local dev)
 * ```ts
 * const credentials: AgentOAuthClientCredentials = {
 *   token_endpoint: 'https://auth.example.com/oauth/token',
 *   client_id: 'abc123',
 *   client_secret: 'shh-its-a-secret',
 *   scope: 'adcp',
 * };
 * ```
 *
 * @example Env-var reference (CI — no on-disk secret)
 * ```ts
 * const credentials: AgentOAuthClientCredentials = {
 *   token_endpoint: 'https://auth.example.com/oauth/token',
 *   client_id: 'abc123',
 *   client_secret: '$ENV:ADCP_CLIENT_SECRET',
 *   scope: 'adcp',
 *   audience: 'https://agent.example.com',
 * };
 * ```
 */
export interface AgentOAuthClientCredentials {
  /**
   * Authorization server token endpoint. Must be HTTPS unless it points at
   * `localhost` / `127.0.0.1` (dev/test carve-out). The exchange helper
   * rejects non-HTTPS URLs at runtime to keep the client secret off the
   * wire in plaintext.
   */
  token_endpoint: string;
  /** OAuth client ID. May be a `$ENV:VAR` reference. */
  client_id: string;
  /** OAuth client secret. May be a `$ENV:VAR` reference. */
  client_secret: string;
  /** Requested OAuth scope (space-delimited for multiple). */
  scope?: string;
  /**
   * RFC 8707 resource indicator(s). Advertises the protected resource the
   * issued token will be used against, so the AS can mint an
   * audience-bound token. Required by some AS deployments (Keycloak in
   * strict mode, AWS Cognito with resource servers) when the agent is
   * behind a proxy that validates `aud`. Accepts a single URI or an array
   * — the library sends one `resource` form field per entry.
   */
  resource?: string | string[];
  /**
   * Audience parameter. Non-standard in RFC 6749 but widely supported by
   * Auth0, Okta, and Azure AD as the preferred way to request an
   * audience-bound token. Send this when the AS documentation calls for
   * `audience=`; otherwise prefer `resource` (RFC 8707).
   */
  audience?: string;
  /**
   * Where to put client credentials on the token request.
   * - `basic` (default): HTTP Basic Auth header (RFC 6749 §2.3.1 preferred).
   * - `body`: `client_id` / `client_secret` form fields in the body.
   *
   * RFC 6749 says servers MUST support Basic and MAY support body — a few
   * popular providers only accept body, so this toggle exists.
   */
  auth_method?: 'basic' | 'body';
}

/**
 * Private JWK carrying the `d` scalar required to sign. Narrower than the
 * generic JWK shape to give hand-authors a compiler error when they paste
 * the public JWK (which lacks `d`) by accident.
 */
export interface AdcpPrivateJsonWebKey {
  kid: string;
  kty: string;
  crv?: string;
  alg?: string;
  use?: string;
  key_ops?: string[];
  x?: string;
  y?: string;
  /** Private scalar. Required for signing. */
  d: string;
  [extra: string]: unknown;
}

/**
 * Request-signing configuration for an agent. When present on an AgentConfig,
 * outbound MCP/A2A calls are gated by the seller's advertised
 * `request_signing` capability block (fetched once via `get_adcp_capabilities`
 * and cached): operations listed in `required_for` / `supported_for` (or
 * `always_sign`) are signed with this key per RFC 9421.
 *
 * Content-digest coverage is resolved per request from the seller's
 * advertised `covers_content_digest` policy: `required` covers, `forbidden`
 * omits, `either` (or absent) covers by default — body-binding is the safer
 * choice and a seller advertising `either` has explicitly allowed both forms.
 *
 * Two shapes, discriminated on `kind`:
 * - `'inline'` (default) — private JWK held in process memory.
 * - `'provider'` — delegates `sign()` to a {@link SigningProvider} so private
 *   key material can live in a managed key store (GCP KMS, AWS KMS, etc.).
 */
export type AgentRequestSigningConfig = AgentRequestSigningConfigInline | AgentRequestSigningConfigProvider;

/** Operation-list overrides shared by both `request_signing` shapes. */
export interface AgentRequestSigningOperationOverrides {
  /**
   * AdCP operation names to sign regardless of the seller's advertisement.
   * Useful during pilots before a counterparty flips an op into `required_for`.
   */
  always_sign?: string[];
  /**
   * When true, also sign operations the seller lists in `supported_for` (but
   * not `required_for`). Defaults to false — conservative "sign what the
   * seller asks for" behavior.
   */
  sign_supported?: boolean;
  /**
   * Informational mirror of the JWKS endpoint where this agent publishes
   * its verification keys. Verifiers do not read this field — they walk
   * brand.json from `agent_url` to discover the authoritative `jwks_uri`.
   * The field is carried on the buyer-side config so audit logs, custom
   * verifier wiring, and split-domain setups have a single self-describing
   * source of truth that matches what brand.json publishes.
   *
   * Common case: split-domain setups where the JWKS lives off the
   * conventional `${agent_url}/.well-known/jwks.json` path (identity
   * domain separate from the agent endpoint). Make sure brand.json's
   * `jwks_uri` agrees with whatever you set here — brand.json is
   * authoritative; this field documents intent.
   */
  jwks_uri?: string;
}

/**
 * In-process signing identity. The SDK loads the private JWK at request time
 * and signs synchronously — appropriate for development, testing, and
 * deployments where holding the private scalar in process memory is
 * acceptable.
 *
 * `kind` defaults to `'inline'` so existing literals without the field
 * continue to type-check.
 */
export interface AgentRequestSigningConfigInline extends AgentRequestSigningOperationOverrides {
  /** Discriminator. Defaults to `'inline'` so legacy literals work unchanged. */
  kind?: 'inline';
  /** Key identifier (published by the buyer at its JWKS endpoint) */
  kid: string;
  /** Signature algorithm. Must match the key material. */
  alg: 'ed25519' | 'ecdsa-p256-sha256';
  /**
   * Private signing key as a JWK. Must include `d` (the private scalar);
   * other fields mirror the public JWK the buyer publishes for verification.
   */
  private_key: AdcpPrivateJsonWebKey;
  /**
   * Agent's base URL (e.g., `https://buyer.example.com`). Consistent with
   * every other `agent_url` field across AdCP — formats, creatives, signals,
   * brand. Sellers derive the JWKS endpoint via the conventional well-known
   * suffix (`{agent_url}/.well-known/adcp-jwks.json`); a handful of deploys
   * override the path via seller-side resolver configuration.
   *
   * The client does not read this field — the signer only needs the local
   * private key — but it's carried here so the field sits next to `kid` /
   * `alg` / `private_key` and is available to downstream audit logging or
   * custom verifier wiring.
   */
  agent_url: string;
}

/**
 * KMS-backed (or otherwise externalized) signing identity. The SDK calls
 * `provider.sign(payload)` on every signed request — async, may dispatch
 * to a managed key store. Use a {@link SigningProvider} for production
 * deployments that keep private keys out of process memory.
 *
 * The `kid` and `alg` come from the provider itself; this shape only carries
 * the agent's `agent_url` and the operation-list overrides.
 */
export interface AgentRequestSigningConfigProvider extends AgentRequestSigningOperationOverrides {
  kind: 'provider';
  /**
   * The signing provider that produces RFC 9421 signature bytes. Imported
   * from `@adcp/client/signing` — see `SigningProvider` for the interface
   * contract and `examples/gcp-kms-signing-provider.ts` for a reference
   * KMS adapter.
   */
  provider: SigningProvider;
  /** Agent base URL — same semantics as the inline shape. */
  agent_url: string;
}

// Agent Configuration Types
export interface AgentConfig {
  id: string;
  name: string;
  agent_uri: string;
  protocol: 'mcp' | 'a2a';

  /**
   * Static authentication token
   * Use this for API keys or pre-issued bearer tokens
   */
  auth_token?: string;

  /**
   * OAuth tokens for dynamic authentication
   * The client will automatically refresh tokens when they expire
   */
  oauth_tokens?: AgentOAuthTokens;

  /**
   * OAuth client registration info
   * Stored after dynamic client registration
   */
  oauth_client?: AgentOAuthClient;

  /**
   * OAuth 2.0 client credentials grant configuration (M2M).
   * When present, tokens in `oauth_tokens` are refreshed by re-exchanging
   * these credentials against `token_endpoint` — there is no user-facing
   * authorization flow.
   */
  oauth_client_credentials?: AgentOAuthClientCredentials;

  /**
   * PKCE code verifier (temporary, during OAuth flow)
   * @internal
   */
  oauth_code_verifier?: string;

  /**
   * Additional HTTP headers to include in every request to this agent.
   * Useful for sending API keys, org IDs, or other vendor-specific headers
   * alongside the standard authorization token.
   *
   * Example:
   * ```typescript
   * headers: {
   *   'x-api-key': 'quota-key',
   *   'x-org-id': 'org-123'
   * }
   * ```
   */
  headers?: Record<string, string>;

  /**
   * Optional — when set, outbound requests to this agent are signed per
   * RFC 9421 for operations the agent advertises in its `request_signing`
   * capability block (fetched once via `get_adcp_capabilities` and cached
   * by the client). See {@link AgentRequestSigningConfig}.
   */
  request_signing?: AgentRequestSigningConfig;

  /**
   * Pre-connected MCP `Client` for in-process testing without an HTTP loopback server.
   * When present, tool calls are dispatched directly to this client, bypassing URL
   * validation, OAuth refresh, and the connection cache. All client-side pipeline
   * stages (idempotency injection, schema validation, governance middleware) still apply.
   *
   * Do not set this field directly — use `AgentClient.fromMCPClient()` instead.
   * @internal
   */
  _inProcessMcpClient?: import('@modelcontextprotocol/sdk/client/index.js').Client;
}

// Testing Types
export interface TestRequest {
  agents: AgentConfig[];
  brief: string;
  brand_manifest?: string; // Replaces deprecated promoted_offering
  tool_name?: string;
}

/** Structured debug log entry emitted during protocol and governance interactions */
export interface DebugLogEntry {
  type: string;
  [key: string]: unknown;
}

export interface TestResult {
  agent_id: string;
  agent_name: string;
  success: boolean;
  response_time_ms: number;
  data?: unknown;
  error?: string;
  timestamp: string;
  debug_logs?: DebugLogEntry[];
  validation?: Record<string, unknown>;
}

// API Response Types
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

export interface AgentListResponse {
  agents: AgentConfig[];
  total: number;
}

export interface TestResponse {
  test_id: string;
  results: TestResult[];
  summary: {
    total_agents: number;
    successful: number;
    failed: number;
    average_response_time_ms: number;
  };
}

// Creative Library Management Types (AdCP v1.3.0)
export interface CreativeLibraryItem {
  creative_id: string;
  name: string;
  format: string;
  type: 'image' | 'video' | 'html' | 'native';
  // Asset content (mutually exclusive)
  media_url?: string;
  snippet?: string;
  snippet_type?: 'html' | 'javascript' | 'amp';
  // Metadata
  dimensions?: {
    width: number;
    height: number;
  };
  file_size?: number;
  duration?: number;
  tags?: string[];
  status: 'active' | 'inactive' | 'pending_review' | 'approved' | 'rejected';
  // Library-specific fields
  created_date: string;
  last_updated: string;
  assignments: string[]; // Array of media_buy_ids or package_ids
  assignment_count: number;
  performance_metrics?: CreativePerformanceMetrics;
  compliance?: CreativeComplianceData;
  sub_assets?: CreativeSubAsset[];
}

export interface CreativePerformanceMetrics {
  impressions?: number;
  clicks?: number;
  ctr?: number;
  conversions?: number;
  cost_per_conversion?: number;
  performance_score?: number;
  last_updated: string;
}

export interface CreativeComplianceData {
  brand_safety_status: 'approved' | 'flagged' | 'rejected' | 'pending';
  policy_violations?: string[];
  last_reviewed: string;
  reviewer_notes?: string;
}

// New Task Request/Response Types
export interface ManageCreativeAssetsRequest {
  action: 'upload' | 'list' | 'update' | 'assign' | 'unassign' | 'delete';
  adcp_version?: string;
  // Action-specific parameters
  assets?: CreativeAsset[]; // For upload
  filters?: CreativeFilters; // For list
  pagination?: PaginationOptions; // For list
  creative_id?: string; // For update
  updates?: Partial<CreativeAsset>; // For update
  creative_ids?: string[]; // For assign/unassign/delete
  media_buy_id?: string; // For assign/unassign
  buyer_ref?: string; // For assign/unassign
  package_assignments?: { [creative_id: string]: string[] }; // For assign
  package_ids?: string[]; // For unassign
  archive?: boolean; // For delete (soft vs hard delete)
}

export interface SyncCreativesRequest {
  creatives: CreativeAsset[];
  patch?: boolean; // Enable partial updates
  dry_run?: boolean; // Preview changes without applying
  assignments?: { [creative_id: string]: string[] }; // Bulk assign to packages
  validation_mode?: 'strict' | 'lenient';
}

export interface ListCreativesRequest {
  filters?: CreativeFilters;
  sort?: {
    field: string;
    direction: 'asc' | 'desc';
  };
  pagination?: PaginationOptions;
  include_assignments?: boolean;
  include_performance?: boolean;
}

export interface CreativeFilters {
  format?: FormatID | FormatID[];
  type?: ('image' | 'video' | 'html' | 'native') | ('image' | 'video' | 'html' | 'native')[];
  status?: string | string[];
  tags?: string | string[];
  created_after?: string;
  created_before?: string;
  updated_after?: string;
  updated_before?: string;
  assigned_to?: string; // media_buy_id or package_id
  performance_score_min?: number;
  performance_score_max?: number;
}

/** @deprecated Use PaginationRequest from tools.generated instead */
export interface PaginationOptions {
  offset?: number;
  limit?: number;
  cursor?: string;
}

// Response Types
export interface ManageCreativeAssetsResponse {
  success: boolean;
  action: string;
  results?: {
    uploaded?: CreativeLibraryItem[];
    listed?: {
      creatives: CreativeLibraryItem[];
      total_count: number;
      pagination?: {
        offset: number;
        limit: number;
        has_more: boolean;
        next_cursor?: string;
      };
    };
    updated?: CreativeLibraryItem;
    assigned?: {
      creative_id: string;
      assignments: string[];
    }[];
    unassigned?: {
      creative_id: string;
      removed_from: string[];
    }[];
    deleted?: {
      creative_id: string;
      archived: boolean;
    }[];
  };
  errors?: {
    creative_id?: string;
    error_code: string;
    message: string;
  }[];
}

export interface ListCreativesResponse {
  success: boolean;
  creatives: CreativeLibraryItem[];
  total_count: number;
  pagination?: {
    offset: number;
    limit: number;
    has_more: boolean;
    next_cursor?: string;
  };
}

// Property Types - Used for discovery and property management
export interface Property {
  property_id?: string;
  property_type: PropertyType;
  name: string;
  identifiers: PropertyIdentifier[];
  tags?: string[];
  publisher_domain?: string;
}

export interface PropertyIdentifier {
  type: PropertyIdentifierType;
  value: string;
  include_subdomains?: boolean;
}

export type PropertyType = 'website' | 'mobile_app' | 'ctv_app' | 'dooh' | 'podcast' | 'radio' | 'streaming_audio';

export type PropertyIdentifierType =
  | 'domain'
  | 'subdomain'
  | 'ios_bundle'
  | 'android_package'
  | 'apple_app_store_id'
  | 'google_play_id'
  | 'amazon_app_store_id'
  | 'roku_channel_id'
  | 'samsung_app_id'
  | 'lg_channel_id'
  | 'vizio_app_id'
  | 'fire_tv_app_id'
  | 'dooh_venue_id'
  | 'podcast_rss_feed'
  | 'spotify_show_id'
  | 'apple_podcast_id'
  | 'iab_tech_lab_domain_id'
  | 'custom';

/** Grouped types by tool type */
export type AsyncResponseByTask = {
  create_media_buy:
    | CreateMediaBuyResponse
    | CreateMediaBuyAsyncWorking
    | CreateMediaBuyAsyncInputRequired
    | CreateMediaBuyAsyncSubmitted;
  get_products:
    | GetProductsResponse
    | GetProductsAsyncWorking
    | GetProductsAsyncInputRequired
    | GetProductsAsyncSubmitted;
  update_media_buy:
    | UpdateMediaBuyResponse
    | UpdateMediaBuyAsyncWorking
    | UpdateMediaBuyAsyncInputRequired
    | UpdateMediaBuyAsyncSubmitted;
  sync_creatives:
    | SyncCreativesResponse
    | SyncCreativesAsyncWorking
    | SyncCreativesAsyncInputRequired
    | SyncCreativesAsyncSubmitted;
};

export type AsyncResponseFor<TTask extends keyof AsyncResponseByTask> = AsyncResponseByTask[TTask];

export type CreateMediaBuyAsyncResponseData = AsyncResponseFor<'create_media_buy'>;
export type GetProductsAsyncResponseData = AsyncResponseFor<'get_products'>;
export type UpdateMediaBuyAsyncResponseData = AsyncResponseFor<'update_media_buy'>;
export type SyncCreativesAsyncResponseData = AsyncResponseFor<'sync_creatives'>;
