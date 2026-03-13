# AdCP Client Developer Guide

> **📖 This guide is for GitHub Copilot. For complete AI coding assistant instructions, see [../AGENTS.md](../AGENTS.md)**

## Quick Reference

This is **@adcp/client** - the official TypeScript client library for the Ad Context Protocol (AdCP).

**Critical rules** (see [AGENTS.md](../AGENTS.md) for details):

- ✅ Always use official `@a2a-js/sdk` and `@modelcontextprotocol/sdk` clients
- ❌ Never use mock data - return exactly what agents provide
- ✅ Use changesets for version management (never edit package.json version manually)

## Project Components

1. **Library** (`src/lib/`) - NPM package for AdCP agents communication
2. **CLI** (`bin/`) - Command-line tooling for testing agents

## Architecture Quick Reference

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
const client = new ADCPClient(agent, {
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

### Environment Separation

- **Library version** (package.json) - Managed by changesets
- **AdCP schema version** (src/lib/version.ts) - Independent protocol version

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

### Webhook Testing

Use EventEmitter for webhook simulation:

```javascript
const testEmitter = new EventEmitter();
mockWebhookManager.registerWebhook = mock.fn(async () => {
  setTimeout(() => testEmitter.emit('webhook', taskId, data), 100);
});
```

### Test Commands

```bash
npm test                   # Unit tests
npm run test:protocols     # Protocol compliance tests
npm run test:e2e          # End-to-end against live server
npm run test:all          # Full test suite
```

## CLI Tool & Webhook Handling

### CLI Async Operations

```bash
npx @adcp/client agent-url get_products '{"brief":"test"}' --webhook --timeout 30
# Automatically starts webhook handler with ngrok tunnel
```

### Webhook URL Templates

Flexible macro substitution system:

```typescript
webhookUrlTemplate: 'https://app.com/webhook/{task_type}/{agent_id}/{operation_id}';
// Macros: {agent_id}, {task_type}, {operation_id}
```

## File Organization Patterns

- `src/lib/core/` - Main client classes (ADCPClient, TaskExecutor)
- `src/lib/protocols/` - A2A/MCP protocol implementations
- `src/lib/types/` - Generated TypeScript types from schemas
- `test/lib/` - Library unit tests
- `test/e2e/` - Integration tests
- `examples/` - Usage examples and demos

## Key Entry Points

- **Library export**: `src/lib/index.ts` - Main public API
- **CLI**: `bin/adcp.js` - Command-line interface
- **Types**: Auto-generated from `src/lib/types/tools.generated.ts`

## Common Gotchas

1. **Protocol clients**: Always use official `@a2a-js/sdk` and `@modelcontextprotocol/sdk`
2. **Mock data**: Never inject fallback data when agents return empty responses
3. **Version management**: Let changesets handle package.json, edit ADCP_VERSION separately

## References

- **AdCP Specification**: https://docs.adcontextprotocol.org/docs/
- **Protocol Repository**: https://github.com/adcontextprotocol/adcp
- **NPM Package**: https://www.npmjs.com/package/@adcp/client
