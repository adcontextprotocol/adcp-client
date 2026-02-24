/**
 * AdCP Registry Types
 *
 * Generated types are in types.generated.ts (from OpenAPI spec).
 * This file re-exports them with ergonomic names and adds client-specific types.
 */

// Re-export generated component schema types
export type {
  ResolvedBrand,
  LocalizedName,
  BrandRegistryItem,
  ResolvedProperty,
  PropertyIdentifier,
  PropertyRegistryItem,
  ValidationResult,
  RegistryError,
  PublisherPropertySelector,
  FederatedAgentWithDetails,
  AgentHealth,
  AgentStats,
  AgentCapabilities,
  PropertySummary,
  FederatedPublisher,
  DomainLookupResult,
} from './types.generated';

// Re-export the full generated module for advanced usage (paths, operations, etc.)
export type { paths, operations, components } from './types.generated';

// ====== Operation-derived types ======
// Types extracted from inline OpenAPI operation schemas

import type { operations } from './types.generated';

/** Request body for POST /api/brands/save */
export type SaveBrandRequest = NonNullable<operations['saveBrand']['requestBody']>['content']['application/json'];

/** Response from POST /api/brands/save (200) */
export type SaveBrandResponse = operations['saveBrand']['responses']['200']['content']['application/json'];

/** Request body for POST /api/properties/save */
export type SavePropertyRequest = NonNullable<operations['saveProperty']['requestBody']>['content']['application/json'];

/** Response from POST /api/properties/save (200) */
export type SavePropertyResponse = operations['saveProperty']['responses']['200']['content']['application/json'];

/** Request body for POST /api/adagents/validate */
export type ValidateAdagentsRequest = NonNullable<
  operations['validateAdagents']['requestBody']
>['content']['application/json'];

/** Request body for POST /api/adagents/create */
export type CreateAdagentsRequest = NonNullable<
  operations['createAdagents']['requestBody']
>['content']['application/json'];

/** Request body for POST /api/registry/validate/product-authorization */
export type ValidateProductAuthorizationRequest = NonNullable<
  operations['validateProductAuthorization']['requestBody']
>['content']['application/json'];

/** Request body for POST /api/registry/expand/product-identifiers */
export type ExpandProductIdentifiersRequest = NonNullable<
  operations['expandProductIdentifiers']['requestBody']
>['content']['application/json'];

// ====== Backward compatibility ======

/** @deprecated Use ResolvedProperty instead */
export type PropertyInfo = import('./types.generated').ResolvedProperty;

// ====== Client-specific types (not in the API schema) ======

/** A single company match from a brand search query. */
export interface CompanySearchResult {
  domain: string;
  canonical_domain: string;
  brand_name: string;
  house_domain?: string;
  parent_brand?: string;
  keller_type: 'master' | 'sub_brand' | 'endorsed' | 'independent';
  brand_agent_url?: string;
  source: string;
}

/** Result from findCompany() brand search. */
export interface FindCompanyResult {
  results: CompanySearchResult[];
}

/** Configuration for the registry client. */
export interface RegistryClientConfig {
  /** Base URL of the AdCP registry. Defaults to https://adcontextprotocol.org */
  baseUrl?: string;
  /** API key for authenticated registry access. Falls back to ADCP_REGISTRY_API_KEY env var. */
  apiKey?: string;
}

/** Options for list/search endpoints with pagination. */
export interface ListOptions {
  search?: string;
  limit?: number;
  offset?: number;
}

/** Options for listing agents with filtering. */
export interface ListAgentsOptions {
  type?: 'creative' | 'signals' | 'sales' | 'governance' | 'si';
  health?: boolean;
  capabilities?: boolean;
  properties?: boolean;
}
