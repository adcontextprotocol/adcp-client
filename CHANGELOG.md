# Changelog

# 2.4.2

- Update `update_media_buy` tool signature to match `create_media_buy` - remove `push_notification_config` from request
- Fix webhook HMAC verification by propagating `X-ADCP-Timestamp` through `AgentClient.handleWebhook` and server route

  Previously, the server only forwarded `X-ADCP-Signature` to the client verifier. The timestamp required by the HMAC scheme (message = `{timestamp}.{json_payload}`) was not passed through, causing verification to fail when `webhookSecret` was enabled. This change:
  - Updates `AgentClient.handleWebhook(payload, signature, timestamp)` to accept and forward the timestamp.
  - Updates the webhook route to extract `X-ADCP-Timestamp` and pass it into `handleWebhook`.
  - Allows `ADCPClient.handleWebhook` to successfully validate signatures using both headers.

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
  import { MediaBuySchema } from "@adcp/client";

  const result = MediaBuySchema.safeParse(data);
  if (result.success) {
    console.log("Valid!", result.data);
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
      console.log("Products received:", response.products);
    },
    onTaskFailed: (metadata, error) => {
      console.error("Task failed:", error);
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
      if (metadata.status === "completed") {
        console.log("Products received:", response.products);
      } else if (metadata.status === "failed") {
        console.error("Task failed:", metadata.error);
      } else if (metadata.status === "needs_input") {
        console.log("Clarification needed:", response.message);
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
import { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new MCPClient({
  name: "My App",
  version: "1.0.0",
});

const transport = new StreamableHTTPClientTransport(new URL(agentUrl));
await client.connect(transport);
const result = await client.callTool({ name: "get_products", arguments: args });

// After (@adcp/client)
import { createMCPClient } from "@adcp/client";

const client = createMCPClient(agentUrl, authToken);
const result = await client.callTool("get_products", args);
```

#### From Testing Framework Only

If you were using this as a testing framework only:

```typescript
// Before (server-side functions)
import { testSingleAgent } from "./protocols";

const result = await testSingleAgent(agentId, brief, offering, toolName);

// After (library client)
import { AdCPClient } from "@adcp/client";

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
