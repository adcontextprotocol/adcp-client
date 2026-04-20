---
'@adcp/client': patch
---

Fix `ProtocolResponseParser.getStatus()` misclassifying spec-compliant AdCP v3 domain envelopes as MCP task-status envelopes. Four `ADCP_STATUS` literals (`completed`, `canceled`, `failed`, `rejected`) collide with domain status enums like `MediaBuyStatus` / `CreativeStatus`. Previously, a seller returning `cancel_media_buy` with `{ structuredContent: { status: "canceled", media_buy: {...}, adcp_version: "3.0.0" } }` got routed through `TaskExecutor`'s terminal-failure branch — the client returned `{ success: false, data: undefined, error: "Task canceled" }` on a successful cancellation.

The parser now disambiguates using an envelope-shape check: exclusive task-lifecycle literals (`submitted`, `working`, `input-required`, `auth-required`) are trusted from `structuredContent.status` unconditionally; shared literals are only treated as task status when the envelope carries no keys outside the `ProtocolEnvelope` allowlist. Otherwise the response falls through to the `COMPLETED` fallback so Zod validators parse the domain payload. Unblocks the `media_buy_state_machine` storyboard on `cancel_buy` / `resume_canceled_buy`. Reported and root-caused by @fgranata in adcp-client#646.
