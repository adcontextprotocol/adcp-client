---
"@adcp/client": minor
---

Fix broken code examples in build-seller-agent skill and improve createAdcpServer DX. Skill fixes: tsc command, creative state transitions, simulateDelivery params, confirmed_at, storyboard table, capabilities casing, channels type inference. Framework fixes: make account optional in registered MCP input schemas for handler-level validation; accept Record<string, unknown> from DomainHandler return types so plain object literals compile without exact type matching. Add compile-time test for all skill file typescript examples.
