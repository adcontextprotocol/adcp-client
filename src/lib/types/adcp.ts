// AdCP Types - Based on official AdCP specification
// https://adcontextprotocol.org/docs/reference/data-models

// Import structured FormatID from generated core types
import type { FormatID } from './core.generated';

export interface MediaBuy {
  id: string;
  campaign_name?: string;
  advertiser_name?: string;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  budget: Budget;
  targeting: Targeting;
  creative_assets: CreativeAsset[];
  delivery_schedule: DeliverySchedule;
  created_at: string;
  updated_at: string;
}

export interface Budget {
  total_budget: number;
  daily_budget?: number;
  currency: string;
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

export interface FrequencyCap {
  impressions: number;
  time_period: 'day' | 'week' | 'month' | 'lifetime';
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

// Agent Configuration Types
export interface AgentConfig {
  id: string;
  name: string;
  agent_uri: string;
  protocol: 'mcp' | 'a2a';
  auth_token_env?: string;
  requiresAuth?: boolean;
}

// Testing Types
export interface TestRequest {
  agents: AgentConfig[];
  brief: string;
  brand_manifest?: string; // Replaces deprecated promoted_offering
  tool_name?: string;
}

export interface TestResult {
  agent_id: string;
  agent_name: string;
  success: boolean;
  response_time_ms: number;
  data?: any;
  error?: string;
  timestamp: string;
  debug_logs?: any[];
  validation?: any;
}

// API Response Types
export interface ApiResponse<T = any> {
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

export interface SyncCreativesResponse {
  success: boolean;
  summary: {
    total_processed: number;
    created: number;
    updated: number;
    assigned: number;
    errors: number;
  };
  results: {
    created?: CreativeLibraryItem[];
    updated?: CreativeLibraryItem[];
    assigned?: { creative_id: string; packages: string[] }[];
    errors?: { creative_id?: string; error_code: string; message: string }[];
  };
  dry_run?: boolean;
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

// AdAgents.json Types - Based on AdCP v2.2.0 specification
export interface AdAgentsJson {
  $schema?: string;
  authorized_agents: AuthorizedAgent[];
  properties?: Property[];
  last_updated?: string;
}

export interface AuthorizedAgent {
  url: string;
  authorized_for: string;
  property_ids?: string[];
}

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
}

export type PropertyType =
  | 'website'
  | 'mobile_app'
  | 'ctv_app'
  | 'dooh'
  | 'podcast'
  | 'radio'
  | 'streaming_audio';

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

// Validation Types
export interface AdAgentsValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  domain: string;
  url: string;
  status_code?: number;
  raw_data?: any;
}

export interface ValidationError {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ValidationWarning {
  field: string;
  message: string;
  suggestion?: string;
}

export interface AgentCardValidationResult {
  agent_url: string;
  valid: boolean;
  status_code?: number;
  card_data?: any;
  card_endpoint?: string;
  errors: string[];
  response_time_ms?: number;
}

// API Request/Response Types for AdAgents Management
export interface ValidateAdAgentsRequest {
  domain: string;
}

export interface ValidateAdAgentsResponse {
  domain: string;
  found: boolean;
  validation: AdAgentsValidationResult;
  agent_cards?: AgentCardValidationResult[];
}

export interface CreateAdAgentsRequest {
  authorized_agents: AuthorizedAgent[];
  include_schema?: boolean;
  include_timestamp?: boolean;
}

export interface CreateAdAgentsResponse {
  success: boolean;
  adagents_json: string;
  validation: AdAgentsValidationResult;
}