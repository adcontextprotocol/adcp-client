---
'@adcp/client': patch
---

Extend the uniform-error-response comparator (adcontextprotocol/adcp-client#738) to walk A2A Task and Message shapes when looking for the AdCP error envelope. `extractEnvelope` now finds `adcp_error` nested in `result.artifacts[].parts[].data` (Task reply) or `result.parts[].data` (Message reply); `peelWrappers` reduces A2A Task/Message bodies to their data-part payloads so per-request `task.id` / `contextId` / `artifactId` / `messageId` don't false-positive structural compares on identical success bodies.

Adds `test/lib/uniform-error-invariant-a2a.test.js` — the A2A-shaped sibling of the existing MCP integration test, running the same five-case matrix (baseline compliant/leak, cross-tenant compliant/leak, baseline fallback) against an in-process A2A seller reached through `@a2a-js/sdk/client`. Closes the gap where only hand-crafted JSON strings exercised the A2A path.
