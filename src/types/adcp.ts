// AdCP Types - Based on official AdCP specification
// https://adcontextprotocol.org/docs/reference/data-models

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
  url: string;
  status: 'active' | 'inactive' | 'pending_review';
  file_size?: number;
  duration?: number;
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
  format_id: string;
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
  promoted_offering?: string;
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