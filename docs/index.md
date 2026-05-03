# ADCP Client Documentation

Welcome to the official documentation for `@adcp/sdk`, the TypeScript/JavaScript client library for the Ad Context Protocol.

## Quick Navigation

### 🤖 For AI Agents

- [`docs/llms.txt`](./llms.txt) — full protocol spec in one file (tools, types, error codes, examples)
- [`skills/call-adcp-agent/SKILL.md`](../skills/call-adcp-agent/SKILL.md) — wire contract, async flow, error recovery (buyer side)

### 🛠 Building a Server-Side Agent

- [Build an Agent](./guides/BUILD-AN-AGENT.md) — `createAdcpServerFromPlatform` + `definePlatform` family
- [Validate Your Agent](./guides/VALIDATE-YOUR-AGENT.md) — five-command checklist + storyboard runner
- [Account Resolution](./guides/account-resolution.md) — `'explicit'` vs `'implicit'` vs `'derived'` mode selection
- [ctx_metadata Safety](./guides/CTX-METADATA-SAFETY.md) — don't store secrets there
- [Signing Guide](./guides/SIGNING-GUIDE.md) — RFC 9421 request signing + JWKS
- [Conformance](./guides/CONFORMANCE.md) — property-based fuzzing against bundled JSON schemas
- Worked reference adapters: `examples/hello_*` family (pick by specialism)

### 📈 Migration Guides

- [6.6 → 6.7](./migration-6.6-to-6.7.md) — fifteen adopter recipes; two breaking (`'implicit'` refusal, `SalesPlatform` split)
- [5.x → 6.x](./migration-5.x-to-6.x.md) — `createAdcpServerFromPlatform` framework shape
- [4.x → 5.x](./migration-4.x-to-5.x.md) — `TaskResult` discriminated union + `createAdcpServer`
- [BuyerAgentRegistry](./migration-buyer-agent-registry.md) — durable buyer-agent identity (deep-dive)

### 🚀 Buyer-Side Getting Started

- [Installation & Setup](./getting-started.md)
- [Basic Usage](./getting-started.md#basic-usage)
- [Authentication](./getting-started.md#authentication)
- [Buyer Input Handler Patterns](./guides/HANDLER-PATTERNS-GUIDE.md)

### 📖 Core Concepts

- [Async Execution Model](./guides/ASYNC-DEVELOPER-GUIDE.md)
- [Type Summary](./TYPE-SUMMARY.md) — curated type signatures (avoid the `*.generated.ts` files)

### 🔧 API Reference

- [AdCPClient](./api/classes/AdCPClient.html)
- [ADCPMultiAgentClient](./api/classes/ADCPMultiAgentClient.html)
- [Type Definitions](./api/modules.html)
- [Full API Documentation](./api/index.html)

### 💡 Guides & Examples

- [Real-World Examples](./guides/REAL-WORLD-EXAMPLES.md)
- [Async Patterns](./guides/ASYNC-DEVELOPER-GUIDE.md) / [Migration](./guides/ASYNC-MIGRATION-GUIDE.md) / [Troubleshooting](./guides/ASYNC-TROUBLESHOOTING-GUIDE.md)
- [Testing Strategy](./guides/TESTING-STRATEGY.md) / [Multi-Instance Testing](./guides/MULTI-INSTANCE-TESTING.md)
- [Recipes](./recipes/) — `composeMethod` testing patterns, etc.

### 📦 Resources

- [npm Package](https://www.npmjs.com/package/@adcp/sdk)
- [GitHub Repository](https://github.com/adcontextprotocol/adcp-client)
- [AdCP Specification](https://adcontextprotocol.org)

## Features at a Glance

✅ **Unified Protocol Support** — single API for both MCP and A2A protocols
✅ **Async Execution** — handle long-running tasks with webhooks and deferrals
✅ **Type Safety** — full TypeScript support with comprehensive type definitions
✅ **Production Ready** — circuit breakers, retries, robust error handling
✅ **Compile-time enforcement** — `RequiredPlatformsFor<S>` catches missing specialism methods at typecheck

## Need Help?

- 📋 [Troubleshooting Guide](./guides/ASYNC-TROUBLESHOOTING-GUIDE.md)
- 🐛 [Report an Issue](https://github.com/adcontextprotocol/adcp-client/issues)
- 💬 [Discussions](https://github.com/adcontextprotocol/adcp-client/discussions)
