/**
 * AdCP Registry Types
 *
 * Generated types are in types.generated.ts (from OpenAPI spec).
 * This file re-exports them with ergonomic names and adds client-specific types.
 */

// Re-export generated component schema types
export type {
  LocalizedName,
  BrandRegistryItem,
  ResolvedProperty,
  PropertyIdentifier,
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
  BrandActivity,
  PropertyActivity,
  PolicySummary,
  Policy,
  PolicyHistory,
  CatalogEvent,
  FeedResponse,
  AgentInventoryProfile,
  AgentSearchResult,
  AgentSearchResponse,
  CrawlRequestResponse,
  AgentCompliance,
  AgentComplianceDetail,
  StoryboardStatus,
  OperatorLookupResult,
  PublisherLookupResult,
  AuthorizationEntry,
  CommunityMirrorListResponse,
  CommunityMirrorSummary,
  CommunityMirrorGetResponse,
  CommunityMirrorAdagentsJson,
  CommunityMirrorPublishResponse,
  CommunityMirrorPublishError,
  CommunityMirrorPublishRequest,
  CommunityMirrorDeleteResponse,
} from './types.generated';

// Re-export the full generated module for advanced usage (paths, operations, etc.)
export type { paths, operations, components } from './types.generated';

// ====== Operation-derived types ======
// Types extracted from inline OpenAPI operation schemas

import type {
  ResolvedBrand as GeneratedResolvedBrand,
  PropertyRegistryItem as GeneratedPropertyRegistryItem,
  operations,
  CommunityMirrorListResponse,
  CommunityMirrorSummary,
  CommunityMirrorGetResponse,
  CommunityMirrorPublishResponse,
  CommunityMirrorPublishError,
  CommunityMirrorPublishRequest,
  CommunityMirrorDeleteResponse,
} from './types.generated';
import type { PropertyIdentifierType, PropertyType } from '../discovery/types';
import type { MediaChannel, ProductFormatDeclaration } from '../types/tools.generated';

/**
 * Brand identity returned by the registry resolver.
 *
 * `parent_brand` is a registry hierarchy reference. New registry responses use
 * the parent brand's canonical domain when the parent has one; older rows may
 * still carry a portfolio-internal brand id from `brand.json#/brands[].id`.
 * Consumers that need ancestry should use `RegistrySync.getAncestors()` rather
 * than walking `parent_brand` directly.
 */
export interface ResolvedBrand extends Omit<GeneratedResolvedBrand, 'parent_brand'> {
  parent_brand?: string;
}

/**
 * Ordered corporate brand hierarchy for a domain, from self to house.
 *
 * This is retained for SDK compatibility with older/self-hosted registry
 * deployments. AdCP 3.1.1 removed the hierarchy endpoints from the public
 * registry OpenAPI; new ancestry consumers should prefer `RegistrySync`.
 */
export interface BrandHierarchyResolution {
  chain: ResolvedBrand[];
}

/**
 * Bulk ordered corporate brand hierarchy result keyed by the requested domain.
 *
 * Retained for SDK compatibility with older/self-hosted registry deployments.
 */
export interface BrandHierarchyBulkResolution {
  results: Record<string, BrandHierarchyResolution | null>;
}

/** Options for client-side brand hierarchy resolution caching. */
export interface ResolveBrandHierarchyOptions {
  /**
   * Cache this resolution in-memory for the provided number of milliseconds.
   * Omit or set to `0` to bypass the SDK cache.
   */
  ttlMs?: number;
  /** Force a registry read and refresh any matching cache entry. */
  fresh?: boolean;
}

/** Request body for POST /api/brands/save */
export type SaveBrandRequest = NonNullable<operations['saveBrand']['requestBody']>['content']['application/json'];

/** Response from POST /api/brands/save (200) */
export type SaveBrandResponse = operations['saveBrand']['responses']['200']['content']['application/json'];

type RegistrySavePropertyRequest = NonNullable<
  operations['saveProperty']['requestBody']
>['content']['application/json'];

type SavePropertyIdentityBase = {
  /** Human-readable property name. */
  name: string;
  /** Register this property by known identifiers such as domain, bundle id, or app-store id. */
  identifiers?: { type: PropertyIdentifierType; value: string }[];
  /** Tags used by downstream `by_tag` property selection. */
  tags?: string[];
};

/** Property identity accepted by POST /api/properties/save. */
export type SavePropertyIdentity = SavePropertyIdentityBase &
  (
    | {
        /** Preferred field name, aligned with adagents.json property declarations. */
        property_type: PropertyType;
        /** Deprecated alias accepted for backwards compatibility. */
        type?: PropertyType | string;
      }
    | {
        /** Deprecated alias for `property_type`; accepted for backwards compatibility. */
        type: PropertyType | string;
        property_type?: PropertyType;
      }
  );

/** Property identity facts returned by registry property read/list APIs. */
export type RegistryPropertyIdentity = {
  /** Stable property identifier when the registry has assigned one. */
  id?: string;
  /** Preferred field name, aligned with adagents.json property declarations. */
  property_type?: PropertyType;
  /** Legacy read/write alias for `property_type`. */
  type?: PropertyType | string;
  /** Human-readable property name. */
  name?: string;
  /** Known identifiers such as domain, bundle id, or app-store id. */
  identifiers?: { type: PropertyIdentifierType; value: string }[];
  /** Tags used by downstream `by_tag` property selection. */
  tags?: string[];
};

/** Property registry list item, including identity facts when returned by the registry. */
export type PropertyRegistryItem = GeneratedPropertyRegistryItem & {
  properties?: RegistryPropertyIdentity[];
};

/** Request body for POST /api/properties/save */
export type SavePropertyRequest = Omit<RegistrySavePropertyRequest, 'authorized_agents' | 'properties'> & {
  /** Ignored by the registry client; identity-only property saves always write `authorized_agents: []`. */
  authorized_agents?: [];
  properties?: SavePropertyIdentity[];
};

/** Response from POST /api/properties/save (200) */
export type SavePropertyResponse = operations['saveProperty']['responses']['200']['content']['application/json'];

/** Response from POST /api/properties/hosted/{domain}/claim (200) */
export type ClaimHostedPropertyDomainResponse =
  operations['claimHostedPropertyDomain']['responses']['200']['content']['application/json'];

/** Response from POST /api/properties/hosted/{domain}/verify-origin (200) */
export type VerifyHostedPropertyOriginResponse =
  operations['verifyHostedPropertyOrigin']['responses']['200']['content']['application/json'];

/** Request body for POST /api/adagents/validate */
export type ValidateAdagentsRequest = NonNullable<
  operations['validateAdagents']['requestBody']
>['content']['application/json'];

/** Request body for POST /api/adagents/create */
type RegistryCreateAdagentsRequest = NonNullable<
  operations['createAdagents']['requestBody']
>['content']['application/json'];

/** Response from POST /api/adagents/create (200) */
type RegistryCreateAdagentsResponse = operations['createAdagents']['responses']['200']['content']['application/json'];

/** Agent authorization entry accepted by the registry adagents.json generator. */
export type AdagentsAuthorizedAgent = RegistryCreateAdagentsRequest['authorized_agents'][number] & {
  [key: string]: unknown;
};

/**
 * Top-level `adagents.json#/formats[]` declaration.
 *
 * This reuses the protocol `ProductFormatDeclaration` shape and adds the
 * publisher-catalog scoping fields allowed in `adagents.json`.
 */
export type AdagentsCatalogFormat = ProductFormatDeclaration & {
  /** Property IDs from this file that this format applies to. Omit for all properties. */
  applies_to_property_ids?: string[];
  /** Property tags from this file that this format applies to. Omit for all properties. */
  applies_to_property_tags?: string[];
};

/** Reference to a top-level `formats[]` entry from a placement declaration. */
export type AdagentsPlacementFormatReference = {
  [key: string]: unknown;
  format_option_id: string;
  /** Use a full `AdagentsCatalogFormat` when declaring inline placement-specific format details. */
  format_kind?: never;
};

/** Placement-level format declaration or same-file top-level format reference. */
export type AdagentsPlacementFormatOption = AdagentsPlacementFormatReference | AdagentsCatalogFormat;

type AdagentsPlacementBase = {
  [key: string]: unknown;
  /** Stable placement identifier unique within this adagents.json file. */
  placement_id: string;
  /** Human-readable placement name. */
  name: string;
  description?: string;
  tags?: string[];
  collection_ids?: string[];
  channels?: MediaChannel[];
  format_options?: AdagentsPlacementFormatOption[];
  ext?: Record<string, unknown>;
};

/** Canonical placement declaration published in `adagents.json#/placements[]`. */
export type AdagentsPlacementDefinition =
  | (AdagentsPlacementBase & { property_ids: string[]; property_tags?: string[] })
  | (AdagentsPlacementBase & { property_tags: string[]; property_ids?: string[] });

/** Metadata for one `adagents.json#/placement_tags` entry. */
export type AdagentsPlacementTag = {
  [key: string]: unknown;
  name: string;
  description: string;
};

/** Request body for POST /api/adagents/create with typed catalog fields. */
export type CreateAdagentsRequest = Omit<
  RegistryCreateAdagentsRequest,
  'authorized_agents' | 'formats' | 'placements' | 'placement_tags'
> & {
  authorized_agents: AdagentsAuthorizedAgent[];
  formats?: AdagentsCatalogFormat[];
  placements?: AdagentsPlacementDefinition[];
  placement_tags?: Record<string, AdagentsPlacementTag>;
};

/** Generated adagents.json payload returned by the registry generator. */
export type CreatedAdagentsJson = Record<string, unknown> & Partial<CreateAdagentsRequest>;

/** Response from POST /api/adagents/create (200). */
export type CreateAdagentsResponse = Omit<RegistryCreateAdagentsResponse, 'data'> & {
  data: {
    success: boolean;
    adagents_json?: CreatedAdagentsJson;
    validation?: unknown;
    [key: string]: unknown;
  };
};

type CommunityMirrorContentKey = 'formats' | 'properties' | 'placements' | 'collections' | 'signals';
type CommunityMirrorCatalogContent = Partial<
  Pick<CreateAdagentsRequest, Extract<CommunityMirrorContentKey, keyof CreateAdagentsRequest>>
> & {
  collections?: Record<string, unknown>[];
  signals?: Record<string, unknown>[];
};

/** Input for building a catalog-only community mirror adagents.json descriptor. */
export type CommunityMirrorAdagentsConfig = Omit<
  CreateAdagentsRequest,
  'authorized_agents' | 'catalog_etag' | 'include_schema' | 'include_timestamp' | 'platform'
> &
  CommunityMirrorCatalogContent & {
    /** Community mirror catalogs should be cacheable static artifacts with stable content identity when available. */
    catalog_etag?: string;
    /** Community mirror catalogs must include at least one non-empty catalog collection. */
    formats?: AdagentsCatalogFormat[];
    /** Optional pointer to a successor adagents.json after a platform adopts AdCP directly. */
    superseded_by?: string;
    /** Seller authorization claims are intentionally not accepted by this helper. */
    authorized_agents?: never;
    /** Generator-only flag; community mirrors are persisted adagents.json documents. */
    include_schema?: never;
    /** Generator-only flag; community mirrors are persisted adagents.json documents. */
    include_timestamp?: never;
  };

/** Input for publishing/upserting a catalog-only community mirror descriptor. */
export type CreateCommunityMirrorAdagentsConfig = CommunityMirrorAdagentsConfig & {
  /**
   * Stable platform key for the hosted mirror. If omitted, RegistryClient can
   * infer it only when every `properties[].platform` value is the same.
   */
  platform?: string;
};

/** Catalog-only community mirror adagents.json descriptor. */
export type CommunityMirrorAdagentsCatalog = Omit<
  CreateAdagentsRequest,
  'authorized_agents' | 'catalog_etag' | 'include_schema' | 'include_timestamp' | 'platform'
> &
  CommunityMirrorCatalogContent & {
    authorized_agents: [];
    catalog_etag?: string;
    formats?: AdagentsCatalogFormat[];
    superseded_by?: string;
  };

/** Response from PUT /api/registry/mirrors/:platform. */
export type PublishCommunityMirrorAdagentsResponse = CommunityMirrorPublishResponse;

/** Summary item from GET /api/registry/mirrors. */
export type CommunityMirrorAdagentsSummary = CommunityMirrorSummary;

/** Response from GET /api/registry/mirrors. */
export type ListCommunityMirrorAdagentsResponse = CommunityMirrorListResponse;

/** Raw response from GET /api/registry/mirrors/:platform. */
export type GetCommunityMirrorAdagentsResponse = CommunityMirrorGetResponse;

/** Raw request body for PUT /api/registry/mirrors/:platform. */
export type PublishCommunityMirrorAdagentsRequest = CommunityMirrorPublishRequest;

/** Validation error from PUT /api/registry/mirrors/:platform. */
export type PublishCommunityMirrorAdagentsError = CommunityMirrorPublishError;

/** Response from DELETE /api/registry/mirrors/:platform. */
export type DeleteCommunityMirrorAdagentsResponse = CommunityMirrorDeleteResponse;

/** Request body for POST /api/registry/validate/product-authorization */
export type ValidateProductAuthorizationRequest = NonNullable<
  operations['validateProductAuthorization']['requestBody']
>['content']['application/json'];

/** Request body for POST /api/registry/expand/product-identifiers */
export type ExpandProductIdentifiersRequest = NonNullable<
  operations['expandProductIdentifiers']['requestBody']
>['content']['application/json'];

/** Query parameters for GET /api/brands/registry */
export type ListBrandsOptions = NonNullable<operations['listBrands']['parameters']['query']>;

/** Query parameters for GET /api/registry/agents */
export type ListAgentsQuery = NonNullable<operations['listAgents']['parameters']['query']>;

/** Response from GET /api/registry/agents (200) */
export type ListAgentsResponse = operations['listAgents']['responses']['200']['content']['application/json'] & {
  /**
   * Backward-compatible SDK field. Current registry responses may omit source
   * summaries, so RegistryClient normalizes this to an empty object.
   */
  sources: Record<string, unknown>;
};

/** Response from GET /api/registry/publishers (200) */
export type ListPublishersResponse = operations['listPublishers']['responses']['200']['content']['application/json'] & {
  /**
   * Backward-compatible SDK field. Current registry responses may omit source
   * summaries, so RegistryClient normalizes this to an empty object.
   */
  sources: Record<string, unknown>;
};

/** Query parameters for GET /api/registry/feed */
export type FeedQuery = NonNullable<operations['getRegistryFeed']['parameters']['query']>;

/** Query parameters for GET /api/registry/agents/search */
export type AgentSearchQuery = NonNullable<operations['searchAgentProfiles']['parameters']['query']> & {
  /** Agent type filter. Accepts current registry types plus legacy aliases. */
  type?: string;
  /** Sort order. */
  sort?: string;
};

/** Request body for POST /api/registry/crawl-request */
export type CrawlRequest = NonNullable<operations['requestCrawl']['requestBody']>['content']['application/json'];

/** Request body for POST /api/registry/manager-revalidation-request */
export type ManagerRevalidationRequest = NonNullable<
  operations['requestManagerRevalidation']['requestBody']
>['content']['application/json'];

/** Response from POST /api/registry/manager-revalidation-request (202) */
export type ManagerRevalidationResponse =
  operations['requestManagerRevalidation']['responses']['202']['content']['application/json'];

/** Query parameters for GET /api/policies/registry */
export type ListPoliciesQuery = NonNullable<operations['listPolicies']['parameters']['query']>;

/** Response from GET /api/policies/registry (200) */
export type ListPoliciesResponse = operations['listPolicies']['responses']['200']['content']['application/json'];

/** Query parameters for GET /api/policies/resolve */
export type ResolvePolicyQuery = operations['resolvePolicy']['parameters']['query'];

/** Response from GET /api/policies/resolve (200) */
export type ResolvePolicyResponse = operations['resolvePolicy']['responses']['200']['content']['application/json'];

/** Request body for POST /api/policies/resolve/bulk */
export type ResolvePoliciesBulkRequest = NonNullable<
  operations['resolvePoliciesBulk']['requestBody']
>['content']['application/json'];

/** Response from POST /api/policies/resolve/bulk (200) */
export type ResolvePoliciesBulkResponse =
  operations['resolvePoliciesBulk']['responses']['200']['content']['application/json'];

/** Query parameters for GET /api/policies/history */
export type GetPolicyHistoryQuery = operations['getPolicyHistory']['parameters']['query'];

/** Response from GET /api/policies/history (200) */
export type GetPolicyHistoryResponse =
  operations['getPolicyHistory']['responses']['200']['content']['application/json'];

/** Request body for POST /api/policies/save */
export type SavePolicyRequest = NonNullable<operations['savePolicy']['requestBody']>['content']['application/json'];

/** Response from POST /api/policies/save (200) */
export type SavePolicyResponse = operations['savePolicy']['responses']['200']['content']['application/json'];

/** Query parameters for GET /api/brands/history */
export type GetBrandHistoryQuery = operations['getBrandHistory']['parameters']['query'];

/** Response from GET /api/brands/history (200) */
export type GetBrandHistoryResponse = operations['getBrandHistory']['responses']['200']['content']['application/json'];

/** Query parameters for GET /api/properties/history */
export type GetPropertyHistoryQuery = operations['getPropertyHistory']['parameters']['query'];

/** Response from GET /api/properties/history (200) */
export type GetPropertyHistoryResponse =
  operations['getPropertyHistory']['responses']['200']['content']['application/json'];

/** Response from GET /api/registry/agents/{agentUrl}/storyboard-status */
export type GetAgentStoryboardStatusResponse =
  operations['getAgentStoryboardStatus']['responses']['200']['content']['application/json'];

/** Response from POST /api/registry/agents/storyboard-status */
export type GetAgentStoryboardStatusBulkResponse =
  operations['bulkAgentStoryboardStatus']['responses']['200']['content']['application/json'];

/** Payload for agent.compliance_changed feed events. */
export interface ComplianceChangedPayload {
  previous_status: import('./types.generated').AgentCompliance['status'];
  current_status: import('./types.generated').AgentCompliance['status'];
  compliance_summary?: import('./types.generated').AgentCompliance;
}

// ====== Brand logo asset types ======

/** Review status for a brand logo asset in the AAO registry. */
export type BrandLogoReviewStatus = 'approved' | 'pending' | 'rejected' | 'deleted';

type BrandLogoAssetBase = {
  /** Registry-assigned stable asset ID. */
  id: string;
  /** Asset MIME type, for example `image/svg+xml` or `image/png`. */
  content_type: string;
  /** Registry source, for example `brandfetch` or `community`. */
  source: string;
  /** Caller- or registry-assigned asset tags. */
  tags: string[];
  /** Legacy relative asset URL, when returned by AAO. */
  legacy_url?: string;
  /** Pixel width for raster assets, when known. */
  width?: number;
  /** Pixel height for raster assets, when known. */
  height?: number;
};

/** Approved brand logo assets are ready to reference from brand.json. */
export type ApprovedBrandLogoAsset = BrandLogoAssetBase & {
  review_status: 'approved';
  url: string;
};

/**
 * Pending community logo assets are still under review and must not be treated
 * as brand.json-ready until a later list call returns them as approved.
 */
export type PendingBrandLogoAsset = BrandLogoAssetBase & {
  review_status: 'pending';
  url?: string;
  message?: string;
  review_sla_hours?: number;
};

/** Review-only logo assets that are no longer eligible for public brand.json use. */
export type ReviewedBrandLogoAsset = BrandLogoAssetBase & {
  review_status: 'rejected' | 'deleted';
  url?: string;
};

/**
 * A logo asset returned by AAO brand-logo endpoints.
 *
 * @remarks
 * These endpoints are not yet present in the generated registry OpenAPI
 * types, so this hand-rolled shape mirrors the current AAO response contract.
 */
export type BrandLogoAsset = ApprovedBrandLogoAsset | PendingBrandLogoAsset | ReviewedBrandLogoAsset;

/** Response from GET /api/brands/:domain/logos. */
export interface ListBrandLogosResponse {
  domain?: string;
  assets: BrandLogoAsset[];
  stats?: Record<string, unknown>;
  /** @deprecated Use `assets`. Preserved for older AAO responses and callers. */
  logos?: BrandLogoAsset[];
}

/** Options for listing brand logo assets. */
export interface ListBrandLogosOptions {
  /** Optional tag filters, serialized as a comma-separated `tags` query parameter. */
  tags?: string[];
}

/** Input for POST /api/brands/:domain/logos. */
export interface SaveBrandLogoInput {
  domain: string;
  data: Blob | Buffer | ArrayBuffer | ArrayBufferView;
  filename: string;
  mimeType: string;
  tags: string[];
  note?: string;
}

/** @deprecated Use `SaveBrandLogoInput`. */
export type UploadBrandLogoInput = SaveBrandLogoInput;

/**
 * Response from POST /api/brands/:domain/logos.
 *
 * @remarks
 * These endpoints are not yet present in the generated registry OpenAPI
 * types, so this hand-rolled shape mirrors the current AAO response contract.
 */
export type SaveBrandLogoResponse = {
  success?: boolean;
  domain: string;
  logo_id: string;
  review_status: BrandLogoReviewStatus;
  url?: string;
  legacy_url?: string;
  message?: string;
  review_sla_hours?: number;
};

/** @deprecated Use `SaveBrandLogoResponse`. */
export type UploadBrandLogoResponse = SaveBrandLogoResponse;

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
  /** Base URL of the AdCP registry. Defaults to https://agenticadvertising.org */
  baseUrl?: string;
  /** API key for authenticated registry access. Falls back to ADCP_REGISTRY_API_KEY env var. */
  apiKey?: string;
  /** Request timeout in milliseconds. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Maximum response body size in bytes before JSON parsing. Defaults to 256 KiB. */
  maxBodyBytes?: number;
  /** Redirect policy for registry requests. Defaults to 'error'. */
  redirect?: 'follow' | 'error';
  /** Fetch implementation for tests and custom runtimes. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
}

/** Options for list/search endpoints with pagination. */
export interface ListOptions {
  search?: string;
  limit?: number;
  offset?: number;
}

/** Options for listing agents with filtering. */
export type ListAgentsOptions = Omit<
  ListAgentsQuery,
  'type' | 'health' | 'capabilities' | 'properties' | 'compliance' | 'verified' | 'verification_mode'
> & {
  type?: ListAgentsQuery['type'] | 'si';
  health?: boolean | 'true';
  capabilities?: boolean | 'true';
  properties?: boolean | 'true';
  compliance?: boolean | 'true';
  verified?: boolean | 'true';
  verification_mode?: ListAgentsQuery['verification_mode'] | 'spec' | 'live';
};
