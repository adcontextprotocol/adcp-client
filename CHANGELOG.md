# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- **HITL Setup Documentation** - Created comprehensive `HITL-SETUP.md` with security-first configuration guide
- **Comprehensive Protocol Testing** - Added protocol compliance, schema validation, and integration contract tests
- **Security Documentation** - Enhanced README.md with security best practices and environment variable usage
- **CI Validation** - Added server configuration tests to prevent deployment issues

### Changed
- **Testing Strategy** - Implemented comprehensive protocol testing strategy documented in `PROTOCOL-TESTING-STRATEGY.md`
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
  version: '1.0.0'
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
const result = await client.callTool(agentId, toolName, { brief, promoted_offering: offering });
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