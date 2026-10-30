---
'@adcp/sdk': minor
---

Stop working around the task-response envelope (#3481). `core/protocol-envelope.json` has made `status` REQUIRED on every task response since 3.1; the closed 3.2.x compact schemas only omitted it by not composing the envelope, and AdCP 3.3 (adcontextprotocol/adcp#8547) composes it into every response root.

- `list_products`, `decline_proposals`, `list_collections` and `list_proposals` keep `status` whenever the served release's published schema composes the envelope. A seller serving 3.2.x, whose `list_products` / `decline_proposals` arms are closed with no `status`, still omits it. The release's own schema decides (`omitsEnvelopeStatusForRelease`), so a bundle that composes the envelope changes the answer without a code change. `STATUS_FREE_SYNC_RESPONSE_TOOLS` is replaced by `COMPACT_SYNC_RESPONSE_TOOLS`, which only stops the 3.0 shim from synthesizing a status.
- Response validation no longer clears `additionalProperties: false` on every response root (`relaxResponseRoot()` is removed). A bundle that composes the envelope is validated exactly as published, `status` required. For a closed pre-composition root (3.2.7 and earlier), only the envelope fields that release's own `protocol-envelope.json` defines (`status`, `task_id`, `replayed`, the `adcp_version` echo, …) are accepted on the closed nodes, so body typos are still rejected. No envelope field is added to or removed from a response.
- The Zod generator keeps `ProtocolEnvelope.and(union)` response bodies and merges the compact submitted envelope for both the pre- and post-composition layouts, so types generate from an envelope-composing bundle (ListProductsResponse gains `status: TaskStatus`).
