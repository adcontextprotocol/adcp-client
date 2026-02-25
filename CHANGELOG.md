# Changelog

## 3.25.1

### Patch Changes

- fca1a4b: Fix v2 brand_manifest URL: use base domain instead of /.well-known/brand.json path, which may not exist on advertiser domains and caused "brand_manifest must provide brand information" errors from v2 servers like Magnite.

## 3.25.0

### Minor Changes

- 9cb2cf5: feat: adapt get_products requests for v2 servers
  - Add `adaptGetProductsRequestForV2` to convert v3 request fields to v2 equivalents:
    - `brand` (BrandReference) → `brand_manifest` (string URL)
    - `catalog` → `promoted_offerings` (type='offering') or `promoted_offerings.product_selectors` (type='product')
    - v3 channel names mapped to v2 equivalents (olv/ctv → video, streaming_audio → audio, retail_media → retail)
    - Strip v3-only fields: `buying_mode`, `buyer_campaign_ref`, `property_list`, `account_id`, `pagination`
    - Strip v3-only filter fields: `required_features`, `required_axe_integrations`, `required_geo_targeting`, `signal_targeting`, `regions`, `metros`
  - Add `normalizeProductChannels` to expand v2 channel names to v3 on response products (video → [olv, ctv], audio → streaming_audio, native → display, retail → retail_media)
  - Wire `get_products` into `adaptRequestForServerVersion` switch in `SingleAgentClient`
  - Normalize `brand_manifest` and `product_selectors` in `normalizeRequestParams` before Zod validation for backwards compatibility
  - Strip v3-only package fields (`optimization_goal`) and top-level fields (`account_id`, `proposal_id`, `total_budget`, `artifact_webhook`, `reporting_webhook`) when adapting `create_media_buy`/`update_media_buy` for v2 servers

## 3.24.0

### Minor Changes

- 081dc21: Add `findCompany()` to RegistryClient for resolving colloquial brand names to canonical forms via `GET /api/brands/find`
- b3a03f8: Infer buying_mode from brief presence on get_products for backwards compatibility

## 3.23.0

### Minor Changes

- 7143b35: Add `headers` field to `AgentConfig` for per-agent custom HTTP headers

  Enables sending additional HTTP headers (API keys, org IDs, etc.) alongside the standard bearer token on every request to a specific agent. Auth headers always take precedence over custom headers.

## 3.22.0

### Minor Changes

- 3842fcd: Wrap new AdCP capabilities: buying_mode on GetProductsRequest, CatalogFieldMapping, CatalogFieldBinding, Overlay types. Add checkPropertyList and getPropertyCheckReport to RegistryClient. Registry OpenAPI spec now synced automatically via sync-schemas.

## 3.21.0

### Minor Changes

- 6128d21: Sync AdCP schemas and implement get_media_buys tool
  - Add `get_media_buys` request validation via `GetMediaBuysRequestSchema`
  - Add `GetMediaBuysRequest` / `GetMediaBuysResponse` types and Zod schemas (generated)
  - Add `getMediaBuys()` method to `Agent` and `AgentCollection`
  - Add `get_creative_features` types and agent methods
  - Rename `campaign_ref` to `buyer_campaign_ref` across create/update media buy
  - Add `max_bid` boolean to CPM/VCPM/CPC/CPCV/CPV pricing options

## 3.20.0

### Minor Changes

- 55e6294: Add test suite orchestrator to `@adcp/client/testing`

  New exports:
  - `testAllScenarios(agentUrl, options)` — discovers agent capabilities and runs all applicable scenarios, returning a `SuiteResult`
  - `getApplicableScenarios(tools, filter?)` — returns which scenarios are applicable for a given tool list
  - `SCENARIO_REQUIREMENTS` — maps each scenario to its required tools
  - `DEFAULT_SCENARIOS` — the canonical set of scenarios the orchestrator runs
  - `formatSuiteResults(suite)` — markdown formatter for suite results
  - `formatSuiteResultsJSON(suite)` — JSON formatter for suite results
  - `SuiteResult` type — aggregated result across all scenarios
  - `OrchestratorOptions` type — `TestOptions` extended with optional `scenarios` filter

## 3.19.0

### Minor Changes

- 4718fa0: Sync AdCP catalog schemas: add `sync_catalogs` task, `Catalog` core type, and new catalog-related enums (`CatalogType`, `CatalogAction`, `CatalogItemStatus`). The `GetProductsRequest` now accepts a `catalog` field for product selection. Deprecated `PromotedProducts` and `PromotedOfferings` types are retained in the backwards-compatibility layer with a `promotedProductsToCatalog()` migration helper.

## 3.18.0

### Minor Changes

- c8eef79: Sync upstream AdCP schema: sandbox mode support and creative format filters
  - Added `sandbox?: boolean` to `Account`, `MediaBuyFeatures`, and all task response types (`GetProductsResponse`, `CreateMediaBuySuccess`, `UpdateMediaBuySuccess`, `SyncCreativesSuccess`, `ListCreativesResponse`, `ListCreativeFormatsResponse`, `GetMediaBuyDeliveryResponse`, `ProvidePerformanceFeedbackSuccess`, `SyncEventSourcesSuccess`, `LogEventSuccess`, `SyncAudiencesSuccess`, `BuildCreativeSuccess`, `ActivateSignalSuccess`, `GetSignalsResponse`)
  - Added `sandbox?: boolean` filter to `ListAccountsRequest` and `SyncAccountsRequest`
  - Added `output_format_ids` and `input_format_ids` filter fields to `ListCreativeFormatsRequest`
  - Added `input_format_ids` to `Format`

## 3.17.0

### Minor Changes

- 4292c77: Add sync_audiences tool support and BrandReference migration
  - Added `testSyncAudiences()` scenario for testing first-party CRM audience management
  - Added `audienceManagement` feature detection in capabilities
  - Added `sync_audiences` to supported tool list
  - Migrated from `BrandManifest` to `BrandReference` (upstream schema change)
  - Backwards-compatible: `BrandManifest`, `BrandManifestReference`, and `brandManifestToBrandReference()` re-exported from `compat.ts` with deprecation notice
  - Updated `TestOptions` to accept `brand?: { domain: string; brand_id?: string }` and `audience_account_id?: string`

## 3.16.0

### Minor Changes

- 03d47c6: Add full AdCP Registry client with 28 SDK methods and 17 CLI commands

  Generates TypeScript types from the registry OpenAPI spec using openapi-typescript. Expands RegistryClient with methods for brand/property listing, agent discovery, authorization validation, search, and adagents tooling. Adds corresponding CLI commands including list-brands, list-properties, search, agents, publishers, stats, validate, lookup, discover, and check-auth.

### Patch Changes

- 253c86b: Fix: retry StreamableHTTP on session errors instead of falling back to SSE. When a server returns 404 "Session not found", the client now retries with a fresh StreamableHTTP connection rather than incorrectly falling back to SSE transport.

## 3.15.0

### Minor Changes

- 1fb8afc: Sync upstream AdCP schema changes: add CreativeBrief type to BuildCreativeRequest, replace estimated_exposures with forecast on Product, remove proposal_id from GetProductsRequest. Track ADCP_VERSION 'latest' for schema sync.

## 3.14.1

### Patch Changes

- 45b1229: Upgrade @fastify/cors and @fastify/static for Fastify 5 compatibility, fixing production server crash loop
- d22c3b2: Fix OAuth discovery to use RFC 8414 path-aware resolution, trying `{origin}/.well-known/oauth-authorization-server{path}` before falling back to root

## 3.14.0

### Minor Changes

- 094a10b: Add brand and property registry lookup methods via RegistryClient

## 3.13.0

### Minor Changes

- cc02dc8: Sync AdCP schema to 3.0.0-beta.3 with daypart targeting, delivery forecasting, demographic systems, and optional account_id

## 3.12.0

### Minor Changes

- 0d89757: Update to latest AdCP schema with new features:

  **Breaking type changes:**
  - **BrandManifest tone**: Changed from `string` to object with `voice`, `attributes`, `dos`, `donts`
  - **Format.type**: Now optional (`FormatCategory` deprecated in favor of assets array)

  **Targeting & Signals:**
  - **TargetingOverlay**: Added `age_restriction`, `device_platform`, and `language` fields
  - **BrandManifest logos**: Added structured fields (`orientation`, `background`, `variant`)
  - **Data Provider Signals**: New `DataProviderSignalSelector` and `SignalTargeting` types
  - **get_signals**: Now supports `signal_ids` for exact lookups in addition to `signal_spec`

  **Conversion Tracking:**
  - New `EventType` and `ActionSource` enums
  - `Package.optimization_goal` for target ROAS/CPA with attribution windows
  - `Product.conversion_tracking` for conversion-optimized delivery
  - New `sync_event_sources` and `log_event` tools (with Agent class methods)
  - Delivery metrics: `conversion_value`, `roas`, `cost_per_acquisition`, event type breakdowns

  **Creative:**
  - `UniversalMacro` typed enum for creative tracking macro placeholders
  - `BaseIndividualAsset` / `BaseGroupAsset` extracted as named interfaces

  **Pagination:**
  - Standardized `PaginationRequest` / `PaginationResponse` types across all list endpoints
  - New `paginate()` utility to auto-collect all items across pages
  - New `paginatePages()` async generator for progressive page-by-page loading
  - Deprecated legacy `PaginationOptions` (offset/limit pattern)

  **Product Discovery & Pricing:**
  - `PromotedProducts` interface for product selector queries
  - `CPAPricingOption` for cost-per-acquisition pricing model
  - `isCPAPricing()` helper to detect CPA pricing options
  - Geo exclusion fields (`geo_countries_exclude`, `geo_regions_exclude`, etc.)

  **Capabilities:**
  - `EVENT_TRACKING_TOOLS` constant for conversion tracking tool detection
  - `conversionTracking` feature flag in `MediaBuyFeatures`
  - Added `age_restriction`, `device_platform`, `language` feature flags

  **Exports:**
  - All new types exported from main barrel: `PromotedProducts`, `CPAPricingOption`, `EventType`, `ActionSource`, `SyncEventSourcesRequest/Response`, `LogEventRequest/Response`
  - `isCPAPricing` utility exported alongside existing pricing helpers

## 3.11.2

### Patch Changes

- bbdb92a: Add OAuth support to CLI test command
  - Add `--oauth` flag to test command for OAuth-protected MCP agents
  - Send both `Authorization: Bearer` and `x-adcp-auth` headers in MCP requests (standard OAuth header + legacy AdCP for backwards compatibility)
  - Add token expiry check before running tests with saved OAuth tokens

## 3.11.1

### Patch Changes

- 6ec7e3e: Extract shared `is401Error` helper for centralized 401 authentication error detection

## 3.11.0

### Minor Changes

- cdcf3a7: Add `@adcp/client/auth` export path for OAuth and authentication utilities

## 3.10.0

### Minor Changes

- d7f6ce7: Add OAuth discovery utilities for checking if MCP servers support OAuth authentication.

  New exports:
  - `discoverOAuthMetadata(agentUrl)` - Fetches OAuth Authorization Server Metadata from `/.well-known/oauth-authorization-server`
  - `supportsOAuth(agentUrl)` - Simple boolean check if server supports OAuth
  - `supportsDynamicRegistration(agentUrl)` - Check if server supports dynamic client registration
  - `OAuthMetadata` type - RFC 8414 Authorization Server Metadata structure
  - `DiscoveryOptions` type - Options for discovery requests (timeout, custom fetch)

### Patch Changes

- d7f6ce7: Export Account domain types from main entry point
  - `Account` - billing account interface
  - `ListAccountsRequest` - request params for listing accounts
  - `ListAccountsResponse` - response payload with accounts array

  The types existed in tools.generated.ts but weren't explicitly exported from @adcp/client.

## 3.9.0

### Minor Changes

- 1e919b7: ### Breaking Changes

  **TaskExecutor behavior changes for async statuses:**
  - **`working` status**: Now returns immediately as a successful result (`success: true`, `status: 'working'`) instead of polling until completion or timeout. Callers should use the returned `taskId` to poll for completion or set up webhooks.
  - **`input-required` status**: Now returns as a successful paused state (`success: true`, `status: 'input-required'`) instead of throwing `InputRequiredError` when no handler is provided. Access the input request via `result.metadata.inputRequest`.

  **Migration:**

  ```typescript
  // Before: catching InputRequiredError
  try {
    const result = await executor.executeTask(agent, task, params);
  } catch (error) {
    if (error instanceof InputRequiredError) {
      // Handle input request
    }
  }

  // After: checking result status
  const result = await executor.executeTask(agent, task, params);
  if (result.status === 'input-required') {
    const { question, field } = result.metadata.inputRequest;
    // Handle input request
  }
  ```

  **Conversation context changes:**
  - `wasFieldDiscussed(field)`: Now returns `true` only if the agent explicitly requested that field via an `input-required` response (previously checked if any message contained the field).
  - `getPreviousResponse(field)`: Now returns the user's response to a specific field request (previously returned any message content containing the field).

  ### New Features
  - Added v3 protocol testing scenarios:
    - `capability_discovery` - Test `get_adcp_capabilities` and verify v3 protocol support
    - `governance_property_lists` - Test property list CRUD operations
    - `governance_content_standards` - Test content standards listing and calibration
    - `si_session_lifecycle` - Test full SI session: initiate → messages → terminate
    - `si_availability` - Quick check for SI offering availability
  - Exported `ProtocolClient` and related functions from main library for testing purposes

- 38ba6a6: Add OAuth support for MCP servers
  - New OAuth module in `src/lib/auth/oauth/` with pluggable flow handlers
  - `MCPOAuthProvider` implements MCP SDK's `OAuthClientProvider` interface
  - `CLIFlowHandler` for browser-based OAuth with local callback server
  - OAuth tokens stored directly in AgentConfig alongside static auth tokens
  - CLI flags: `--oauth` for OAuth auth, `--clear-oauth` to clear tokens
  - `--save-auth <alias> <url> --oauth` to save agents with OAuth
  - Auto-detection of OAuth requirement when MCP servers return UnauthorizedError
  - Helper functions: `hasValidOAuthTokens`, `clearOAuthTokens`, `getEffectiveAuthToken`
  - Security fix: use spawn instead of exec for browser open to prevent command injection

## 3.8.1

### Patch Changes

- 7365296: Fix schema validation for v2 pricing options in get_products responses

  When servers return v2-style pricing options (rate, is_fixed, price_guidance.floor), schema validation now normalizes them to v3 format (fixed_price, floor_price) before validation. This ensures v2 server responses pass validation against v3 schemas.

## 3.8.0

### Minor Changes

- d3869a1: Add ADCP v3.0 compatibility while preserving v2.5/v2.6 backward compatibility

  **New Features:**
  - Capability detection via `get_adcp_capabilities` tool or synthetic detection from tool list
  - v3 request/response adaptation for pricing fields (fixed_price, floor_price)
  - Authoritative location redirect handling with loop detection and HTTPS validation
  - Server-side adapter interfaces (ContentStandardsAdapter, PropertyListAdapter, ProposalManager, SISessionManager)
  - New domains: governance, sponsored-intelligence, protocol

  **Adapters:**
  - Pricing adapter: normalizes v2 (rate, is_fixed) to v3 (fixed_price, floor_price)
  - Creative adapter: handles v2/v3 creative assignment field differences
  - Format renders adapter: normalizes format render structures
  - Preview normalizer: handles v2/v3 preview response differences

  **Breaking Change Handling:**
  - All v2 responses automatically normalized to v3 API
  - Clients always see v3 field names regardless of server version
  - v2 servers receive adapted requests with v2 field names

### Patch Changes

- d3869a1: Fix multi-agent partial failure handling using Promise.allSettled

## 3.7.1

### Patch Changes

- 3a60592: Fix JavaScript syntax error in testing UI and update hono for security
  - **UI Fix**: Resolved syntax error in `index.html` dimension parsing logic that caused `toggleAddAgent` and other functions to be undefined. The invalid `} else { } else if {` structure was corrected to proper nested conditionals.
  - **Security**: Updated `hono` from 4.11.3 to 4.11.4 to fix high-severity JWT algorithm confusion vulnerabilities (GHSA-3vhc-576x-3qv4, GHSA-f67f-6cw9-8mq4).

## 3.7.0

### Minor Changes

- 302089a: Add AdCP v2.6 support with backward compatibility for Format schema changes
  - New `assets` field in Format schema (replaces deprecated `assets_required`)
  - Added format-assets utilities: `getFormatAssets()`, `getRequiredAssets()`, `getOptionalAssets()`, etc.
  - Updated testing framework to use new utilities
  - Added URL input option for image/video assets in testing UI
  - Added 21 unit tests for format-assets utilities

## 3.6.0

### Minor Changes

- 2749985: Add `test` subcommand to CLI for running agent test scenarios

  New CLI command enables testing AdCP agents directly from the command line:

  ```bash
  # List available test scenarios
  npx @adcp/client test --list-scenarios

  # Run discovery tests against the built-in test agent
  npx @adcp/client test test

  # Run a specific scenario
  npx @adcp/client test test full_sales_flow

  # Test your own agent
  npx @adcp/client test https://my-agent.com discovery --auth $TOKEN

  # JSON output for CI pipelines
  npx @adcp/client test test discovery --json
  ```

  Available scenarios include: health_check, discovery, create_media_buy, full_sales_flow,
  error_handling, validation, pricing_edge_cases, and more.

  The command exits with code 0 on success, 3 on test failure, making it suitable for CI pipelines.

## 3.5.2

### Patch Changes

- fb041b6: Fix validation error when agents return empty publisher_domains array

  The JSON Schema defines `minItems: 1` for publisher_domains, which caused validation to fail when agents returned empty arrays. This is a common scenario when an agent isn't authorized for any publishers yet.

  The fix relaxes the generated TypeScript types and Zod schemas to accept empty arrays by:
  - Removing `minItems` constraints during TypeScript type generation
  - Converting tuple patterns (`z.tuple([]).rest()`) to arrays (`z.array()`) in Zod schema generation

  This change improves interoperability with real-world agents that may return empty arrays for optional array fields.

## 3.5.1

### Patch Changes

- 15244b1: fix(testing): Use publisher_domains instead of legacy authorized_properties in discovery tests

## 3.5.0

### Minor Changes

- 6d5d050: Add comprehensive E2E agent testing framework with support for discovery, media buy creation, creative sync, and behavioral analysis scenarios.
- 9b34827: Simplify authentication configuration by removing `requiresAuth` and `auth_token_env` fields.

  **Breaking Changes:**
  - `AgentConfig.requiresAuth` has been removed - if `auth_token` is provided, it will be used
  - `AgentConfig.auth_token_env` has been removed - use `auth_token` directly with the token value

  **Migration:**

  ```typescript
  // Before
  const config = {
    id: 'my-agent',
    agent_uri: 'https://agent.example.com',
    protocol: 'mcp',
    requiresAuth: true,
    auth_token_env: 'MY_TOKEN_ENV_VAR', // or auth_token: 'direct-token'
  };

  // After
  const config = {
    id: 'my-agent',
    agent_uri: 'https://agent.example.com',
    protocol: 'mcp',
    auth_token: process.env.MY_TOKEN_ENV_VAR, // or 'direct-token'
  };
  ```

  The simplified model: if `auth_token` is provided, it's sent with requests. If not provided, no authentication is sent.

### Patch Changes

- e602659: Regenerate TypeScript types to match AdCP v2.5.1 schemas

## 3.4.0

### Minor Changes

- 0494341: Updates webhook handler to better support mcp and a2a payloads. Adds typed payloads; Makes reporting webhook configurable;

### Patch Changes

- a639f2c: Fix skipping .data generation when status is submitted
- b1ad29d: feat: URL canonicalization and agent comparison

  **Auto-detect A2A protocol for .well-known/agent-card.json URLs**

  When users provide a `.well-known/agent-card.json` URL (e.g., `https://example.com/.well-known/agent-card.json`), the library now correctly detects this as an A2A agent card discovery URL and switches to the A2A protocol.

  **Canonical URL resolution**

  Added methods to resolve and compare agents by their canonical base URL:
  - `getCanonicalUrl()` - Synchronously returns the canonical base URL (computed from configured URL)
  - `resolveCanonicalUrl()` - Async method that fetches the agent card (A2A) or discovers endpoint (MCP) to get the authoritative canonical URL
  - `isSameAgent(other)` - Compare two agents by canonical URL
  - `isSameAgentResolved(other)` - Async comparison that resolves canonical URLs first
  - `getResolvedAgent()` - Get agent config with canonical URL resolved

  Canonical URL computation:
  - For A2A: Uses the `url` field from the agent card, or strips `/.well-known/agent-card.json`
  - For MCP: Strips `/mcp` or `/mcp/` suffix from discovered endpoint

  This enables comparing agents regardless of how they were configured:

  ```typescript
  // These all resolve to the same canonical URL: https://example.com
  agent1.agent_uri = 'https://example.com';
  agent2.agent_uri = 'https://example.com/mcp';
  agent3.agent_uri = 'https://example.com/.well-known/agent-card.json';

  client.agent('agent1').isSameAgent(client.agent('agent2')); // true
  ```

  Fixes #175

## 3.3.3

### Patch Changes

- fbc29ae: Fix CLI --auth flag to use literal token values directly

  The CLI was incorrectly setting `auth_token_env` (environment variable name) instead of `auth_token` (direct value) when the user provided `--auth TOKEN`. This caused authentication to fail with "Environment variable not found" warnings because the auth module tried to look up the literal token as an environment variable name.

- 53d7cec: Remove spurious index signature types from generated validation schemas

  The `json-schema-to-typescript` library was incorrectly generating index signature types (e.g., `{ [k: string]: unknown }`) for schemas with `oneOf` and `additionalProperties: false`. This caused validation to allow arbitrary extra fields on requests like `update_media_buy` and `provide_performance_feedback`.

  Changes:
  - Added `removeIndexSignatureTypes()` function to post-process generated types
  - Added `update_media_buy` and `list_creatives` schemas to the validation map
  - Added tests for request validation with extra fields

## 3.3.2

### Patch Changes

- 27693b2: Fixed CLI bug where agentConfig was not wrapped in array for AdCPClient constructor

## 3.3.1

### Patch Changes

- ec50aae: Fix Zod schema validation to accept null values for all optional fields. Updated the schema generator to apply `.nullish()` globally to all optional schema fields, allowing both `null` and `undefined` values where TypeScript types permit.

## 3.3.0

### Minor Changes

- a322f4c: fix: treat working/input-required as valid intermediate states and extract A2A webhook payloads
  - `working` status now returns immediately with `status: 'working'` instead of polling and timing out
  - `input-required` status returns valid result instead of throwing `InputRequiredError` when no handler provided
  - Made `success=true` consistent for all intermediate states (working, submitted, input-required, deferred)
  - Added `taskType` parameter to `handleWebhook` for all client classes (SingleAgentClient, AgentClient, ADCPMultiAgentClient)
  - `handleWebhook` now extracts ADCP response from raw A2A task payloads (artifacts[0].parts[].data where kind === 'data')
  - Handlers now receive unwrapped ADCP responses instead of raw A2A protocol structure

## 3.2.1

### Patch Changes

- 918a91a: Fixed ProtocolResponseParser to correctly detect input-required status in A2A JSON-RPC wrapped responses. The parser now checks response.result.status.state for A2A responses before falling back to other status locations, preventing "Schema validation failed" errors when agents return input-required status.

## 3.2.0

### Minor Changes

- 8b05170: Clean up SDK public API and improve response handling

  IMPROVEMENTS:
  1. Agent class methods now return raw AdCP responses matching schemas exactly
  2. Removed internal implementation details from public API exports
  3. Added response utilities: unwrapProtocolResponse, isAdcpError, isAdcpSuccess

  ## What Changed

  **Low-level Agent class** now returns raw AdCP responses matching the protocol specification:
  - Success responses have required fields per schema (packages, media_buy_id, buyer_ref)
  - Error responses follow discriminated union: `{ errors: [{ code, message }] }`
  - Errors returned as values, not thrown as exceptions

  **High-level clients unchanged** - ADCPMultiAgentClient, AgentClient, and SingleAgentClient still return `TaskResult<T>` with status-based patterns. No migration needed for standard usage.

  ## API Export Cleanup

  Removed internal utilities that were never meant for public use:
  - Low-level protocol clients (ProtocolClient, callA2ATool, callMCPTool)
  - Internal utilities (CircuitBreaker, getCircuitBreaker, generateUUID)
  - Duplicate exports (NewAgentCollection)

  Public API now includes only user-facing features:
  - All Zod schemas (for runtime validation, forms)
  - Auth utilities (getAuthToken, createAdCPHeaders, etc.)
  - Validation utilities (validateAgentUrl, validateAdCPResponse)
  - Response utilities (unwrapProtocolResponse, isAdcpError, isAdcpSuccess)

  ## Migration Guide (Only if using low-level Agent class directly)

  **Most users don't need to migrate** - if you're using ADCPMultiAgentClient, AgentClient, or SingleAgentClient, no changes needed.

  ### If using Agent class directly:

  ```javascript
  // Before:
  const agent = new Agent(config, client);
  const result = await agent.createMediaBuy({...});
  if (result.success) {
    console.log(result.data.media_buy_id);
  }

  // After:
  const agent = new Agent(config, client);
  const result = await agent.createMediaBuy({...});
  if (result.errors) {
    console.error('Failed:', result.errors);
  } else {
    console.log(result.media_buy_id, result.buyer_ref);
  }
  ```

  ### Removed Internal Exports

  If you were importing `ProtocolClient`, `CircuitBreaker`, or other internal utilities, use the public Agent class instead.

### Patch Changes

- b2b7c8b: Fixed A2A webhook configuration placement to match A2A SDK specification.

  **Bug Fix: A2A Webhook Configuration Placement**

  The A2A protocol requires webhook configuration to be placed in the top-level `configuration` object, not in skill parameters.

  **Correct format per A2A SDK:**

  ```javascript
  {
    message: { messageId, role, kind, parts: [...] },
    configuration: {
      pushNotificationConfig: { url, headers }
    }
  }
  ```

  **Previous incorrect format:**

  ```javascript
  {
    message: {
      parts: [
        {
          data: {
            skill: 'toolName',
            parameters: {
              pushNotificationConfig: { url, headers }, // WRONG - not a skill parameter
            },
          },
        },
      ];
    }
  }
  ```

  **Changes:**
  - Moved `pushNotificationConfig` from skill parameters to `params.configuration` in A2A protocol handler
  - MCP protocol correctly continues to use `push_notification_config` in tool arguments (per MCP spec)
  - Uses generated `PushNotificationConfig` type from AdCP schema for type safety
  - Fixed A2A artifact validation to check `artifactId` field per @a2a-js/sdk Artifact interface

  **Documentation:**
  - Added AGENTS.md section clarifying `push_notification_config` (async task status) vs `reporting_webhook` (reporting metrics)
  - Both use PushNotificationConfig schema but have different purposes and placement requirements

- 8b05170: Fix CLI tool missing dependency file in published package. The adcp command now works correctly when installed via npx.

## 3.1.0

### Minor Changes

- discriminated-unions-fix: Add discriminated union support and fix missing AdCP tools. Re-synced AdCP schemas to include all 13 tools (was only generating 4). Added support for discriminated unions in type definitions.
- slow-kings-boil: Fixed critical validation bug where sync_creatives, create_media_buy, build_creative, and get_products requests were not being validated. Request validation now uses strict mode to reject unknown top-level fields.

### Patch Changes

- 1763342270: Added explicit auth_token field and fixed auth_token_env to properly support environment variable lookup. AgentConfig now supports two authentication methods: auth_token (direct value) and auth_token_env (environment variable name).
- d064ad36: Fixed A2A protocol to use 'parameters' field instead of 'input' per AdCP specification.
- make-reporting-webhook-configurable: Make reporting_webhook configurable.

## 3.0.3

### Patch Changes

- a4cc9da: Fix CLI tool missing dependency file in published package. The adcp command now works correctly when installed via npx.

## 3.0.2

### Patch Changes

- 579849e: add support for application level context management

## 3.0.1

### Patch Changes

- c24cd21: Fix CLI tool missing dependency file in published package. The adcp command now works correctly when installed via npx.
- c24cd21: Fixed MCP and A2A protocol authentication issues. MCP endpoints now receive required Accept headers, and CLI properly sets requiresAuth flag for authenticated agents.

## 3.0.0

### Major Changes

- 5c1d32e: Simplified API surface - removed deprecated exports and renamed primary client to `AdCPClient`.

  ## Breaking Changes

  **Removed:**
  - `AdCPClient` (deprecated wrapper with confusing lowercase 'd')
  - `createAdCPClient()`, `createAdCPClientFromEnv()` factory functions
  - `createADCPClient()`, `createADCPMultiAgentClient()` factory functions
  - `SingleAgentClient` and `AgentClient` exports from `/advanced` (use `client.agent(id)` instead)

  **Moved to `/advanced`:**
  - Protocol-level clients: `ProtocolClient`, `callMCPTool`, `callA2ATool`, `createMCPClient`, `createA2AClient`

  **Renamed:**
  - `ADCPMultiAgentClient` → `AdCPClient` (primary export, proper AdCP capitalization)

  ## New API

  ```typescript
  import { AdCPClient } from '@adcp/client';

  const client = new AdCPClient([agentConfig]);
  const client = AdCPClient.fromEnv();
  ```

  Works for single or multiple agents. See `MIGRATION-v3.md` for migration guide.

### Minor Changes

- bd57dd1: Added test helpers for easy testing and self-documenting examples. New exports include `testAgent` (pre-configured MCP test agent), `testAgentA2A` (pre-configured A2A test agent), `testAgentNoAuth` / `testAgentNoAuthA2A` (unauthenticated variants for demonstrating auth requirements), `testAgentClient` (multi-agent client with both protocols), `createTestAgent()` helper function, and `creativeAgent` (pre-configured MCP creative agent). Test helpers are available via `@adcp/client/testing` subpath export and provide instant access to AdCP's public test agent and official creative agent with no configuration required.

  Also added built-in CLI aliases (`test`, `test-a2a`, `test-no-auth`, `test-a2a-no-auth`, `creative`) for zero-config command-line access to test and creative agents.

### Patch Changes

- bd57dd1: Fixed authentication bug where tokens shorter than 20 characters were incorrectly treated as environment variable names. The `auth_token_env` field now always contains the actual token value. For environment variable expansion, use shell substitution (e.g., `--auth $MY_TOKEN`).

## 2.7.2

### Patch Changes

- 523e490: Fix CLI tool missing dependency file in published package. The adcp command now works correctly when installed via npx.
- a73d530: Fix MCP authentication bug where x-adcp-auth header was not being sent to servers. The client now properly includes authentication headers in all MCP requests using the SDK's requestInit.headers option instead of a custom fetch function. This fixes authentication failures with MCP servers that require the x-adcp-auth header.
- 35eab77: Fixed ADCP schema validation for framework-wrapped responses. When agent frameworks like ADK wrap tool responses in the A2A FunctionResponse format `{ id, name, response: {...} }`, the client now correctly extracts the nested data before validation instead of validating the wrapper object. This fixes "formats: Required" validation errors when calling ADK-based agents.
- bae7d59: Added EditorConfig and Prettier configuration files to enforce consistent code style across editors. Updated git hooks to support longer commit messages and improved commit-msg hook to work across different Node.js environments. Fixed localStorage issue in demo agent site that was erasing custom agents on page load.

## 2.7.1

### Patch Changes

- ea72f62: call onActivity function within all tool request/response

## 2.6.1

### Patch Changes

- 1027d34: Fix CLI tool missing dependency file in published package. The adcp command now works correctly when installed via npx.

## 2.5.7

### Patch Changes

- 48add90: PropertyCrawler: Add browser headers and graceful degradation for missing properties array

  **Fixes:**
  1. **Browser-Like Headers**: PropertyCrawler now sends standard browser headers when fetching `.well-known/adagents.json` files:
     - User-Agent: Standard Chrome browser string (required by CDNs like Akamai)
     - Accept, Accept-Language, Accept-Encoding: Browser-standard values
     - From: Crawler identification per RFC 9110 (includes library version)

     This resolves 403 Forbidden errors from publishers with CDN bot protection (e.g., AccuWeather, Weather.com).

  2. **Graceful Degradation**: When a publisher has a valid `adagents.json` file with `authorized_agents` but no `properties` array, PropertyCrawler now:
     - Infers a default property based on the domain
     - Returns the property as discoverable
     - Includes a warning message to guide publishers to add explicit properties
     - Adds warnings array to `CrawlResult` interface

  This enables property discovery even when publishers have completed only partial AdCP setup, improving real-world compatibility.

  **Real-World Impact:**
  - AccuWeather: Now successfully crawled (was failing with 403)
  - Weather.com: Now returns inferred property (was returning nothing)
  - Result: Properties discoverable from partial implementations

  **Breaking Changes:** None - API remains backward compatible. The `CrawlResult.warnings` field is new but optional.

  Fixes #107

## 2.5.6

### Patch Changes

- 470151b: Fixed timeout handling tests to match TaskExecutor behavior. Tests now correctly expect error results instead of thrown exceptions when timeouts occur.
- 934e89f: Fixed Zod schema generation failures and made generation errors fatal. Previously, `ts-to-zod` was failing to generate 19 schemas (including `GetProductsRequestSchema` and `GetProductsResponseSchema`) due to cross-file dependency issues. Now all 82 schemas generate successfully and failures exit with error code 1 to catch issues early.
- 79423e3: Add configurable log levels to PropertyCrawler to reduce noise from expected failures. The PropertyCrawler now accepts a `logLevel` option ('error' | 'warn' | 'info' | 'debug' | 'silent') that controls logging verbosity. Expected failures (404s, HTML responses, missing .well-known/adagents.json files) are now logged at debug level instead of error/warn level, while unexpected failures remain at error level. This prevents log pollution when domains don't have adagents.json files, which is a common and expected scenario.

## 2.5.5

### Patch Changes

- d02ed3c: Fix MCP endpoint discovery Accept header handling and send both auth headers

  The `discoverMCPEndpoint()` and `getAgentInfo()` methods had issues with header handling:
  1. **Lost Accept headers**: Didn't preserve the MCP SDK's required `Accept: application/json, text/event-stream` header
  2. **Missing Authorization header**: Only sent `x-adcp-auth` but some servers expect both headers

  Changes:
  - Updated `discoverMCPEndpoint()` to use the same header-preserving pattern as `callMCPTool()`
  - Updated `getAgentInfo()` to properly handle Headers objects without losing SDK defaults
  - Both methods now correctly extract and merge headers from Headers objects, arrays, and plain objects
  - Now sends **both** `Authorization: Bearer <token>` and `x-adcp-auth: <token>` for maximum compatibility
  - Added TypeScript type annotations for Headers.forEach callbacks

  Impact:
  - MCP endpoint discovery now works correctly with FastMCP SSE servers
  - Authentication works with servers expecting either `Authorization` or `x-adcp-auth` headers
  - Accept headers are properly preserved (fixes "406 Not Acceptable" errors)

## 2.5.4

### Patch Changes

- 3061375: Fixed MCP Accept header handling for Headers objects

  The customFetch function in mcp.ts was incorrectly handling Headers objects by using object spread syntax (`{...init.headers}`), which returns an empty object for Headers instances. This caused the MCP SDK's required `Accept: application/json, text/event-stream` header to be lost.

  **Changes:**
  - Fixed Headers object extraction to use `forEach()` instead of object spread
  - Fixed plain object extraction to use `for...in` loop with `hasOwnProperty` check
  - Added comprehensive tests for Headers object handling and Accept header preservation

  **Bug Timeline:**
  - Bug introduced in v2.3.2 (commit 086be48)
  - Exposed between v2.5.0 and v2.5.1 when SDK started passing Headers objects
  - Fixed in this release

  **Impact:**
  - MCP protocol requests now correctly include the required Accept header
  - MCP servers will no longer reject requests due to missing Accept header

- 4a3e04a: Upgraded @modelcontextprotocol/sdk to 1.20.2

  Updated the MCP SDK dependency from 1.19.1 to 1.20.2 to get the latest bug fixes and improvements.

## 2.5.3

### Patch Changes

- 3061375: Fixed MCP Accept header handling for Headers objects

  The customFetch function in mcp.ts was incorrectly handling Headers objects by using object spread syntax (`{...init.headers}`), which returns an empty object for Headers instances. This caused the MCP SDK's required `Accept: application/json, text/event-stream` header to be lost.

  **Changes:**
  - Fixed Headers object extraction to use `forEach()` instead of object spread
  - Fixed plain object extraction to use `for...in` loop with `hasOwnProperty` check
  - Added comprehensive tests for Headers object handling and Accept header preservation

  **Bug Timeline:**
  - Bug introduced in v2.3.2 (commit 086be48)
  - Exposed between v2.5.0 and v2.5.1 when SDK started passing Headers objects
  - Fixed in this release

  **Impact:**
  - MCP protocol requests now correctly include the required Accept header
  - MCP servers will no longer reject requests due to missing Accept header

- 4a3e04a: Upgraded @modelcontextprotocol/sdk to 1.20.2

  Updated the MCP SDK dependency from 1.19.1 to 1.20.2 to get the latest bug fixes and improvements.

## 2.5.2

### Patch Changes

- cc82c4d: Fixed A2A protocol discovery endpoint and Accept headers
  - Changed discovery endpoint from incorrect `/.well-known/a2a-server` to correct `/.well-known/agent-card.json` per A2A spec
  - Updated Accept header from `application/json` to `application/json, */*` for better compatibility with various server implementations
  - Updated protocol detection test to correctly expect A2A detection for test-agent.adcontextprotocol.org

## 2.5.1

### Patch Changes

- 799dc4a: Optimize pre-push git hook for faster development workflow
  - Reduced pre-push hook execution time from 5+ minutes to ~2-5 seconds
  - Now only runs essential fast checks: TypeScript typecheck + library build
  - Removed slow operations: schema sync, full test suite
  - Full validation (tests, schemas) still runs in GitHub Actions CI
  - Makes git push much faster while catching TypeScript and build errors early

- b257d06: Improved debug logging and error messages for MCP protocol errors
  - CLI now displays debug logs, conversation history, and full metadata when --debug flag is used
  - MCP error responses (`isError: true`) now extract and display the actual error message from `content[].text`
  - Previously showed "Unknown error", now shows detailed error like "Error calling tool 'list_authorized_properties': name 'get_testing_context' is not defined"
  - Makes troubleshooting agent-side errors much easier for developers

- 24a5ed7: UI formatting and error logging improvements
  - Fixed media buy packages to include format_ids array (was causing Pydantic validation errors)
  - Added error-level logging for failed media buy operations (create, update, get_delivery)
  - Fixed format objects display in products table (was showing [object Object])
  - Added runtime schema validation infrastructure with Zod
  - Added request validation to AdCPClient (fail fast on invalid requests)
  - Added configurable validation modes (strict/non-strict) via environment variables
  - Preserved trailing slashes in MCP endpoint discovery
  - Improved error display in UI debug panel with proper formatting
  - Added structured logger utility to replace console statements
  - **BREAKING**: Aligned budget handling with AdCP spec - MediaBuy.budget (object) is now MediaBuy.total_budget (number)
  - **BREAKING**: Removed budget field from CreateMediaBuyRequest (calculated from packages per spec)

## 2.5.0

### Minor Changes

- 739ed7a: Add protocol auto-detection to CLI tool - users can now omit the protocol argument and the CLI will automatically detect whether an endpoint uses MCP or A2A via discovery and URL pattern heuristics
- 739ed7a: Add agent alias support to CLI tool - save agent configurations with short aliases for quick access. Users can now save agents with `--save-auth <alias> <url>` and call them with just `adcp <alias> <tool> <payload>`. Config stored in ~/.adcp/config.json with secure file permissions.

### Patch Changes

- 739ed7a: Fix pre-push hook to skip slow tests by setting CI=true, matching GitHub Actions behavior and preventing unnecessary test timeouts during git push
- 8f9270c: Fix webhook HMAC verification by propagating X-ADCP-Timestamp header through AgentClient.handleWebhook() and server route. Update update_media_buy tool signature to remove push_notification_config (matches create_media_buy). Add auto-injection of reporting_webhook in createMediaBuy when webhookUrlTemplate is configured.

# 2.4.2

- Update `update_media_buy` tool signature to match `create_media_buy` - remove `push_notification_config` from request
- Fix webhook HMAC verification by propagating `X-ADCP-Timestamp` through `AgentClient.handleWebhook` and server route

  Previously, the server only forwarded `X-ADCP-Signature` to the client verifier. The timestamp required by the HMAC scheme (message = `{timestamp}.{json_payload}`) was not passed through, causing verification to fail when `webhookSecret` was enabled. This change:
  - Updates `AgentClient.handleWebhook(payload, signature, timestamp)` to accept and forward the timestamp.
  - Updates the webhook route to extract `X-ADCP-Timestamp` and pass it into `handleWebhook`.
  - Allows `AdCPClient.handleWebhook` to successfully validate signatures using both headers.

## 2.4.1

### Patch Changes

- 9f18fa1: Fix CLI tool missing dependency file in published package. The adcp command now works correctly when installed via npx.

## 2.4.0

### Minor Changes

- 5030c85: Add CLI tool and MCP endpoint auto-discovery
  - Add command-line tool (`bin/adcp.js`) for testing AdCP agents
  - Add automatic MCP endpoint discovery (tests provided path, then tries adding /mcp)
  - Add `getAgentInfo()` method for discovering agent capabilities
  - CLI supports tool discovery, execution, authentication, and async webhook handling

## 2.3.2

### Patch Changes

- 3f8460b: Fix conditional fetch logic for auth headers to prevent sporadic authentication failures when making parallel requests

## 2.3.1

### Patch Changes

- 87bb6d2: Fix A2A Authorization header being overwritten by SDK headers. The custom fetchImpl now spreads SDK headers first, then applies auth headers to ensure they take precedence.
- a8cbaf7: Fix creative sync validation errors by correcting format field name and structure

  Multiple locations in the codebase were incorrectly using `format` instead of `format_id` when creating creative assets for sync_creatives calls. This caused the AdCP agent to reject creatives with validation errors: "Input should be a valid dictionary or instance of FormatId".

  **Fixed locations:**
  - `src/public/index.html:8611` - Creative upload form
  - `src/public/index.html:5137` - Sample creative generation
  - `scripts/manual-testing/full-wonderstruck-test.ts:284` - Test script (also fixed to use proper FormatID object structure)

  All creatives are now properly formatted according to the AdCP specification with the correct `format_id` field containing a FormatID object with `agent_url` and `id` properties.

## 2.3.0

### Minor Changes

- 329ce6e: Add Zod schema exports for runtime validation with automatic generation

  This release adds Zod schema exports alongside existing TypeScript types, enabling runtime validation of AdCP data structures. All core schemas, request schemas, and response schemas are now available as Zod schemas.

  **New exports:**
  - Core schemas: `MediaBuySchema`, `ProductSchema`, `CreativeAssetSchema`, `TargetingSchema`
  - Request schemas: `GetProductsRequestSchema`, `CreateMediaBuyRequestSchema`, `SyncCreativesRequestSchema`, etc.
  - Response schemas: `GetProductsResponseSchema`, `CreateMediaBuyResponseSchema`, `SyncCreativesResponseSchema`, etc.

  **Features:**
  - Runtime validation with detailed error messages
  - Type inference from schemas
  - Integration with React Hook Form, Formik, etc.
  - OpenAPI generation support via zod-to-openapi
  - **Automatic generation**: Zod schemas now generated automatically when running `npm run generate-types`
  - **CI integration**: Pre-push hooks and CI checks ensure schemas stay in sync

  **Automatic workflow:**

  ```bash
  # Sync latest AdCP schemas and generate all types (TypeScript + Zod)
  npm run sync-schemas && npm run generate-types
  ```

  **Usage:**

  ```typescript
  import { MediaBuySchema } from '@adcp/client';

  const result = MediaBuySchema.safeParse(data);
  if (result.success) {
    console.log('Valid!', result.data);
  }
  ```

  **Documentation:**
  - `docs/ZOD-SCHEMAS.md` - Complete usage guide with NPM distribution details
  - `docs/VALIDATION_WORKFLOW.md` - CI integration (existing)
  - `examples/zod-validation-example.ts` - Working examples

### Patch Changes

- 244f639: Sync with AdCP v2.1.0 schema updates for build_creative and preview_creative
  - Add support for creative namespace in schema sync script
  - Generate TypeScript types for build_creative and preview_creative tools
  - Update creative testing UI to handle new schema structure:
    - Support output_format_ids array (was output_format_id singular)
    - Handle new preview response with previews[].renders[] structure
    - Display multiple renders with dimensions and roles for companion ads

  Schema changes from v2.0.0:
  - Formats now have renders array with role and structured dimensions
  - Preview responses: outputs → renders, output_id → render_id, output_role → role
  - Removed format_id and hints fields from preview renders

## 2.1.0

### Minor Changes

- 1b28db9: Add creative agent testing UI and improve error detection
  - Add creative testing UI with full lifecycle workflow (list formats → select → build/preview)
  - Fix FormatID structure to send full {agent_url, id} object per AdCP spec
  - Improve error detection to check for data.error field in agent responses
  - Update to AdCP v2.0.0 schemas with structural asset typing
  - Add FormatID type safety to server endpoints
  - Support promoted_offerings asset type with BrandManifestReference

## 2.0.2

### Patch Changes

- cf846da: Improve type safety and use structured data from schemas
  - Replace custom types with generated schema types (Format, Product, etc)
  - Remove all 'as any' type casts for better type safety
  - Remove 30+ lines of workaround code for non-standard responses
  - Export key schema types for public API (Format, Product, PackageRequest, CreativeAsset, CreativePolicy)
  - Client now expects servers to return proper structured responses per AdCP spec

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.2](https://github.com/adcontextprotocol/adcp-client/compare/v0.4.1...v0.4.2) (2025-10-09)

### Features

- add protocol-level webhook configuration support ([#38](https://github.com/adcontextprotocol/adcp-client/issues/38)) ([89bec3e](https://github.com/adcontextprotocol/adcp-client/commit/89bec3e695b94e551366022be4ea0ccc0b84ff2a))

## [0.4.1](https://github.com/adcontextprotocol/adcp-client/compare/v0.4.0...v0.4.1) (2025-10-08)

### Features

- add event store visibility and persist completed tasks ([#35](https://github.com/adcontextprotocol/adcp-client/issues/35)) ([5470662](https://github.com/adcontextprotocol/adcp-client/commit/5470662983ca4b1df3562e2224436e067c145b35))

### Bug Fixes

- distinguish task completion from operation success ([#34](https://github.com/adcontextprotocol/adcp-client/issues/34)) ([34b8d88](https://github.com/adcontextprotocol/adcp-client/commit/34b8d889745d96f60e00d7f5da45ae19fa253a18))

## [0.4.0] - 2025-10-05

### Changed

#### **BREAKING CHANGE: Handler Naming Convention**

- **All async handlers renamed** from `onXXXComplete` to `onXXXStatusChange` to better reflect their behavior
- Handlers now receive ALL status changes (completed, failed, needs_input, working, submitted), not just completions
- `WebhookMetadata` interface extended with `status` and `error` fields for status inspection

**Affected Handlers:**

- `onGetProductsComplete` → `onGetProductsStatusChange`
- `onListCreativeFormatsComplete` → `onListCreativeFormatsStatusChange`
- `onCreateMediaBuyComplete` → `onCreateMediaBuyStatusChange`
- `onUpdateMediaBuyComplete` → `onUpdateMediaBuyStatusChange`
- `onSubmitMediaBuyComplete` → `onSubmitMediaBuyStatusChange`
- `onCancelMediaBuyComplete` → `onCancelMediaBuyStatusChange`
- `onManageCreativeAssetsComplete` → `onManageCreativeAssetsStatusChange`
- `onSyncCreativesComplete` → `onSyncCreativesStatusChange`
- `onListCreativesComplete` → `onListCreativesStatusChange`
- `onGetMediaBuyComplete` → `onGetMediaBuyStatusChange`
- `onListMediaBuysComplete` → `onListMediaBuysStatusChange`
- `onTaskComplete` → `onTaskStatusChange` (fallback handler)

#### **BREAKING CHANGE: Removed Separate Status Handlers**

- Removed `onTaskSubmitted`, `onTaskWorking`, and `onTaskFailed` handlers
- All status changes now route through the typed handlers (e.g., `onGetProductsStatusChange`)
- Use `metadata.status` to check status type within your handlers

### Added

- **Status field** in `WebhookMetadata` interface to identify the current task status
- **Error field** in `WebhookMetadata` interface for failed task error messages
- **Comprehensive test suite** for async handler status changes (12 tests covering all status types)
- **In-memory event storage** in example server for debugging and observability
- **Events API endpoints** (`/api/events` and `/api/events/:operationId`) for querying stored events

### Migration Guide

**Before (v0.3.0):**

```typescript
const client = new ADCPMultiAgentClient(agents, {
  handlers: {
    onGetProductsComplete: (response, metadata) => {
      console.log('Products received:', response.products);
    },
    onTaskFailed: (metadata, error) => {
      console.error('Task failed:', error);
    },
  },
});
```

**After (v0.4.0):**

```typescript
const client = new ADCPMultiAgentClient(agents, {
  handlers: {
    onGetProductsStatusChange: (response, metadata) => {
      // Check status to handle different cases
      if (metadata.status === 'completed') {
        console.log('Products received:', response.products);
      } else if (metadata.status === 'failed') {
        console.error('Task failed:', metadata.error);
      } else if (metadata.status === 'needs_input') {
        console.log('Clarification needed:', response.message);
      }
    },
  },
});
```

**Why this change?**

- Handlers were already receiving all status changes, but the `Complete` suffix was misleading
- Separate status handlers (`onTaskFailed`, etc.) were redundant with typed handlers
- New naming is more honest about behavior and simplifies the API surface
- `metadata.status` provides clear, type-safe status inspection

## [0.3.0](https://github.com/adcontextprotocol/adcp-client/compare/v0.2.4...v0.3.0) (2025-10-04)

### Features

- fix A2A artifact extraction and add protocol response validation ([#28](https://github.com/adcontextprotocol/adcp-client/issues/28)) ([c4fe2d9](https://github.com/adcontextprotocol/adcp-client/commit/c4fe2d99cfc929f4aa083f95baeb64d3f211bef1))

## [0.2.3] - 2025-09-25

### Fixed

- **A2A Protocol Compliance** - Fixed message format to use `kind: "message"` and `input` instead of deprecated `parameters` field
- **Package-Lock Version Sync** - Resolved version mismatch between package.json (0.2.3) and package-lock.json (0.2.2)
- **MCP Product Extraction** - Fixed product extraction logic for proper display in testing UI

### Security

- **Authentication Token Management** - Removed all hardcoded authentication tokens from source code
- **Environment Variable Security** - Added support for `auth_token_env` to reference environment variables instead of hardcoded values
- **HITL Testing Security** - Created secure HITL setup with `.env.hitl.template` and git-ignored `.env.hitl` file
- **GitGuardian Compliance** - Achieved full compliance with security scanning requirements

### Added

- **Node.js Version Specification** - Added `.nvmrc` file specifying Node.js 20 requirement
- **HITL Setup Documentation** - Created comprehensive `docs/development/hitl-testing.md` with security-first configuration guide
- **Comprehensive Protocol Testing** - Added protocol compliance, schema validation, and integration contract tests
- **Security Documentation** - Enhanced README.md with security best practices and environment variable usage
- **CI Validation** - Added server configuration tests to prevent deployment issues

### Changed

- **Testing Strategy** - Implemented comprehensive protocol testing strategy documented in `docs/development/protocol-testing.md`
- **Documentation Updates** - Updated README.md to reflect v0.2.3 changes, security improvements, and Node.js requirements

### Development

- **Test Organization** - Restructured test suite with protocol-specific test categories
- **Mock Strategy** - Improved mocking strategy to test at SDK integration level instead of HTTP level
- **Error Reporting** - Enhanced error messages and debugging information for protocol issues

## [1.0.0] - 2025-09-20

### Added

#### Core Library Features

- **AdCPClient class** - Main client for interacting with AdCP agents
- **Unified protocol support** - Single API for both MCP and A2A protocols
- **ConfigurationManager** - Environment-based agent configuration loading
- **Type-safe APIs** - Comprehensive TypeScript type definitions
- **Protocol-specific clients** - `createMCPClient()` and `createA2AClient()` factory functions

#### Authentication & Security

- **Built-in authentication** - Bearer token and API key support
- **URL validation** - SSRF attack prevention with security checks
- **Token management** - Environment variable and direct token support
- **Secure defaults** - Production-safe configuration out of the box

#### Reliability & Performance

- **Circuit breaker pattern** - Automatic fault tolerance for failing agents
- **Concurrent request management** - Configurable batching with `MAX_CONCURRENT` limits
- **Timeout handling** - Request timeout with configurable `REQUEST_TIMEOUT`
- **Retry logic** - Built into circuit breaker implementation
- **Debug logging** - Comprehensive request/response logging

#### Tool Support

- **get_products** - Retrieve advertising products with brief and promoted offering
- **list_creative_formats** - Get supported creative formats
- **create_media_buy** - Create media buys from selected products
- **manage_creative_assets** - Upload, update, and manage creative assets
- **sync_creatives** - Bulk synchronization of creative assets
- **list_creatives** - Query and filter creative assets
- **Standard formats** - Built-in creative format definitions

#### Developer Experience

- **Comprehensive documentation** - JSDoc comments for all public APIs
- **Usage examples** - Multiple example files showing different patterns
- **Error handling** - Detailed error messages with actionable information
- **TypeScript IntelliSense** - Full type support with auto-completion

#### Testing Framework

- **Interactive web UI** - Point-and-click testing interface at http://localhost:3000
- **REST API** - Programmatic testing endpoints for CI/CD integration
- **Multi-agent testing** - Parallel execution across multiple agents
- **Performance metrics** - Response time analysis and success rates
- **Debug mode** - Request/response inspection with protocol-level details

#### Package & Distribution

- **Dual-purpose package** - Library + testing framework in one package
- **NPM-ready configuration** - Proper exports, types, and file inclusion
- **CommonJS & ESM support** - Compatible with all Node.js module systems
- **Minimal dependencies** - Only essential protocol SDKs as peer dependencies

### Technical Implementation

#### Architecture

- **Modular design** - Separated concerns in `src/lib/` for library code
- **Protocol abstraction** - Unified interface hiding MCP/A2A differences
- **Clean API surface** - Intuitive methods with consistent naming
- **Extensible design** - Easy to add new protocols and tools

#### Dependencies

- **@a2a-js/sdk** ^0.3.4 - Official A2A protocol client
- **@modelcontextprotocol/sdk** ^1.17.5 - Official MCP protocol client
- **TypeScript** ^5.3.0 - Full type safety and modern JavaScript features
- **Node.js** >=18.0.0 - Modern Node.js runtime support

#### Build System

- **TypeScript compilation** - Separate library and server builds
- **Source maps** - Full debugging support in development
- **Declaration files** - Complete `.d.ts` files for TypeScript users
- **Tree-shaking ready** - ESM exports for optimal bundle sizes

### Documentation

#### Files Added

- **README.md** - Comprehensive library documentation with examples
- **examples/basic-mcp.ts** - Simple MCP client usage
- **examples/basic-a2a.ts** - A2A client with multi-agent testing
- **examples/env-config.ts** - Environment-based configuration
- **API.md** - Detailed API reference (planned)
- **CONTRIBUTING.md** - Development guidelines (planned)
- **SECURITY.md** - Security policy and reporting (planned)

#### Examples & Tutorials

- **Quick start guide** - Get running in under 5 minutes
- **Multi-agent patterns** - Concurrent testing strategies
- **Error handling** - Comprehensive error management examples
- **Authentication setup** - Token configuration and security best practices

### Breaking Changes

This is the initial release, so no breaking changes from previous versions.

### Migration Guide

#### From Raw Protocol SDKs

If you were previously using `@a2a-js/sdk` or `@modelcontextprotocol/sdk` directly:

```typescript
// Before (raw MCP SDK)
import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new MCPClient({
  name: 'My App',
  version: '1.0.0',
});

const transport = new StreamableHTTPClientTransport(new URL(agentUrl));
await client.connect(transport);
const result = await client.callTool({ name: 'get_products', arguments: args });

// After (@adcp/client)
import { createMCPClient } from '@adcp/client';

const client = createMCPClient(agentUrl, authToken);
const result = await client.callTool('get_products', args);
```

#### From Testing Framework Only

If you were using this as a testing framework only:

```typescript
// Before (server-side functions)
import { testSingleAgent } from './protocols';

const result = await testSingleAgent(agentId, brief, offering, toolName);

// After (library client)
import { AdCPClient } from '@adcp/client';

const client = new AdCPClient(agents);
const result = await client.callTool(agentId, toolName, {
  brief,
  promoted_offering: offering,
});
```

### Known Issues

- Repository and homepage URLs in package.json need to be updated for actual publication
- GitHub Actions CI/CD workflow not yet implemented
- Bundle size optimization not yet implemented
- Some server-only dependencies still included in main dependencies

### Upcoming Features (Next Release)

- Request/response interceptors for custom processing
- Connection pooling for improved performance
- Response caching with configurable TTL
- Plugin system for extending functionality
- Metrics and telemetry hooks
- Advanced retry strategies with backoff
- Request deduplication
- GraphQL-style query composition

---

**Note**: This changelog follows the [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format. Each version documents:

- **Added** for new features
- **Changed** for changes in existing functionality
- **Deprecated** for soon-to-be removed features
- **Removed** for now removed features
- **Fixed** for any bug fixes
- **Security** for vulnerability fixes
