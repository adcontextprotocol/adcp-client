# AI Coding Assistant Instructions for AdCP Client

This document contains essential guidelines for AI coding assistants (Claude, Copilot, etc.) working on the AdCP Client project.

## Start Here

**Protocol overview** — Read `docs/llms.txt` for a single-file summary of AdCP: all 46 tools, key types, error codes, common flows, and test scenarios. Also available at https://adcontextprotocol.github.io/adcp-client/llms.txt

**Type reference** — Read `docs/TYPE-SUMMARY.md` for curated type signatures (AgentConfig, TaskResult, ConversationContext, and all tool request/response shapes).

**Do NOT read these files** — they are large generated files that waste context:
- `src/lib/types/tools.generated.ts` (~13,000 lines) — use TYPE-SUMMARY.md instead
- `src/lib/types/core.generated.ts` (~2,000 lines) — use TYPE-SUMMARY.md instead
- `src/lib/types/schemas.generated.ts` (~8,000 lines) — Zod runtime schemas, rarely needed directly
- `src/lib/agents/index.generated.ts` — generated Agent classes, use the client API instead

**Building a server-side agent?** — Read `docs/guides/BUILD-AN-AGENT.md` and the published compliance storyboards at `https://adcontextprotocol.org/compliance/{version}/` (mirrored locally in `compliance/cache/{version}/` after `npm run sync-schemas`).

## Project Overview

**@adcp/client** is the official TypeScript client library for the Ad Context Protocol (AdCP), documented at [docs.adcontextprotocol.org](https://docs.adcontextprotocol.org/docs/).

**Components:**

1. **Library** (`src/lib/`) - NPM package for AdCP agent communication
2. **CLI** (`bin/`) - Command-line tooling for testing agents

## 🚨 CRITICAL REQUIREMENTS - MUST FOLLOW 🚨

### 1. ALWAYS USE OFFICIAL PROTOCOL CLIENTS

- **A2A Protocol**: ALWAYS use the official `@a2a-js/sdk` client
- **MCP Protocol**: ALWAYS use the official `@modelcontextprotocol/sdk` client
- **NEVER** implement custom HTTP fallbacks or protocol implementations
- **NEVER** parse SSE responses manually
- **NEVER** make direct fetch() calls to agent endpoints
- If an official client fails to import, FIX THE IMPORT - don't create workarounds

### 2. NEVER USE MOCK DATA

- **NEVER** inject mock products, formats, or any other fake data
- **NEVER** provide fallback data when agents return empty responses
- **ALWAYS** return exactly what the agents provide
- If an agent returns empty arrays or errors, show that to the user
- Real data only - no exceptions

### 3. MCP CLIENT AUTHENTICATION - CRITICAL

The MCP SDK automatically handles initialization. Authentication must be provided via headers:

```javascript
const transport = new StreamableHTTPClientTransport(url, {
  requestInit: {
    headers: {
      'x-adcp-auth': authToken,
    },
  },
});
await client.connect(transport); // This automatically calls initialize internally
```

## Critical Architecture Patterns

### Protocol Abstraction Layer

The library supports both **A2A** and **MCP** protocols via unified interface:

```typescript
import { ProtocolClient } from './src/lib/protocols';
// Routes to: callA2ATool() or callMCPTool() based on agent.protocol
```

**🚨 CRITICAL: A2A Protocol Implementation Requirements**

The A2A protocol has specific implementation requirements that differ from MCP:

**1. Artifact Field Names**

A2A artifacts use `artifactId` per @a2a-js/sdk Artifact interface, NOT `name`:

```typescript
// Correct (per @a2a-js/sdk)
if (!artifact.artifactId) {
  warnings.push('A2A artifact missing artifactId field');
}

// Incorrect - 'name' doesn't exist in A2A SDK
if (!artifact.name) { ... }
```

**2. Two Types of Webhooks - Do Not Confuse!**

**1. `push_notification_config` - For Async Task Status Updates**

Used for receiving task completion/progress notifications. Placement differs by protocol:

- **A2A Protocol**: Goes in `params.configuration.pushNotificationConfig` (camelCase)

  ```typescript
  await a2aClient.sendMessage({
    message: { /* task content */ },
    configuration: {
      pushNotificationConfig: {  // ← For async task status
        url: webhookUrl,
        token?: clientToken,
        authentication: { schemes: ['HMAC-SHA256'], credentials: secret }
      }
    }
  });
  ```

- **MCP Protocol**: Goes in tool arguments as `push_notification_config` (snake_case)
  ```typescript
  await mcpClient.callTool('create_media_buy', {
    buyer_ref: '...',
    packages: [...],
    push_notification_config: {  // ← For async task status
      url: webhookUrl,
      token?: clientToken,
      authentication: { schemes: ['HMAC-SHA256'], credentials: secret }
    }
  });
  ```

**2. `reporting_webhook` - For Reporting Data Delivery**

Used for receiving periodic performance metrics. **Always stays in skill parameters** (both A2A and MCP):

```typescript
// Both protocols - reporting_webhook in skill parameters
{
  buyer_ref: '...',
  packages: [...],
  reporting_webhook: {  // ← Stays in parameters for BOTH protocols
    url: reportingUrl,
    token?: clientToken,
    authentication: { schemes: ['HMAC-SHA256'], credentials: secret },
    reporting_frequency: 'daily',  // Additional fields specific to reporting
    requested_metrics: ['impressions', 'spend', 'clicks']
  }
}
```

Schema: https://adcontextprotocol.org/schemas/v1/core/push-notification-config.json

The `ProtocolClient.callTool()` method in `src/lib/protocols/index.ts` handles this routing automatically.

### Async Operation Patterns (AdCP PR 78)

All operations follow 5 status patterns based on agent response:

- `completed` - Sync completion with result
- `working` - Long-running, poll with `tasks/get`
- `submitted` - Webhook delivery required
- `input_required` - Agent needs clarification via input handlers
- `deferred` - Client defers decision to human/external system

```typescript
// Core flow in src/lib/core/TaskExecutor.ts
const result = await executor.executeTask(agent, 'get_products', params, inputHandler);
// Status determines next steps: polling, webhook wait, or input handling
```

### Conversation-Aware Input Handling

Agents may need clarifications during execution. Use input handlers:

```typescript
const client = new AdCPClient(agent, {
  handlers: {
    onGetProductsStatusChange: (response, metadata) => {
      // Fires for ALL status changes: sync completion, webhook delivery, etc.
    },
  },
});

// Input handler pattern for clarifications
const handler = async context => {
  return context.inputRequest.field === 'budget' ? 50000 : context.deferToHuman();
};
```

## Build & Release Process

### Changesets-Based Releases

**🚨 NEVER manually edit `package.json` version** - Use changesets:

```bash
npm run changeset          # Create changeset for changes
# Merge PR to main → Auto Release PR created
# Merge Release PR → Auto publish to npm
```

**The correct separation:**

- `package.json` version = **Library version** (managed by changesets)
- `src/lib/version.ts` ADCP_VERSION = **AdCP schema version** (can differ from library version)

### Schema Generation Workflow

Library types auto-generated from AdCP schemas:

```bash
npm run sync-schemas       # Download from protocol repo
npm run generate-types     # Generate TypeScript types
npm run generate-zod-schemas  # Generate runtime validation
```

## Testing Strategies

### Protocol-Level Mocking

Test TaskExecutor patterns by mocking `ProtocolClient.callTool()`:

```javascript
ProtocolClient.callTool = mock.fn(async (agent, taskName, params) => {
  if (taskName === 'tasks/get') return { task: { status: 'working' } };
  return { status: 'submitted' };
});
```

### Test Commands

```bash
npm test                   # Unit tests
npm run test:protocols     # Protocol compliance tests
npm run test:e2e          # End-to-end against live server
npm run test:all          # Full test suite
```

Tests run under `--test-timeout=60000`. If a test hangs indefinitely (high CPU, no output) rather than timing out, send `SIGQUIT` to dump the V8 stack before killing — see [CONTRIBUTING.md § Debugging a hung test](./CONTRIBUTING.md#debugging-a-hung-test).

## File Organization

- `docs/llms.txt` - **Start here**: protocol overview, all tools, types, flows (generated)
- `docs/TYPE-SUMMARY.md` - Curated type reference (generated)
- `src/lib/core/` - Main client classes (AdCPClient, TaskExecutor)
- `src/lib/protocols/` - A2A/MCP protocol implementations
- `src/lib/types/` - Generated TypeScript types from schemas (prefer TYPE-SUMMARY.md)
- `compliance/cache/` - Storyboards pulled from `adcontextprotocol.org/compliance/{version}/` (gitignored; populated by `npm run sync-schemas`)
- `test/lib/` - Library unit tests
- `test/e2e/` - Integration tests
- `examples/` - Usage examples and demos

## Backwards Compatibility

**This is a published npm library. Callers on older versions must not break when we add new required fields.**

When adding a new required field to a request schema:

1. **Infer it from existing fields** in `SingleAgentClient.normalizeRequestParams()` so callers that don't send it still work
2. **Update all internal callers** (testing scenarios) to send the field explicitly
3. **Add tests** verifying the inference works and that explicit values are preserved

Example: `buying_mode` was added as required on `get_products`. The client infers it from `brief` presence — callers that only sent `{ brief: '...' }` keep working.

The pattern:

- `normalizeRequestParams()` runs before validation, filling in derivable fields
- `validateRequest()` runs Zod schemas after normalization
- `adaptRequestForServerVersion()` handles v3→v2 downgrades for older servers

**Never add a required field without a backwards-compatible default or inference path.**

## Common Gotchas

1. **Protocol clients**: Always use official `@a2a-js/sdk` and `@modelcontextprotocol/sdk`
2. **Mock data**: Never inject fallback data when agents return empty responses
3. **Version management**: Let changesets handle package.json, edit ADCP_VERSION separately
4. **Backwards compatibility**: New required schema fields need inference in `normalizeRequestParams()`

## References

- [Protocol overview (llms.txt)](https://adcontextprotocol.github.io/adcp-client/llms.txt)
- [API Documentation](https://adcontextprotocol.github.io/adcp-client/api/index.html)
- [AdCP Specification](https://adcontextprotocol.org)
- [A2A SDK](https://github.com/a2a/a2a-js-sdk)
- [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Changesets Documentation](https://github.com/changesets/changesets)
