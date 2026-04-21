---
'@adcp/client': patch
---

Skill example refresh to match recent upstream schema changes and fix a brand-rights coverage gap surfaced by the `compliance:skill-matrix` dogfood harness:

- `list_creative_formats.renders[]`: upstream restructured renders to require `role` plus exactly one of `dimensions` (object) or `parameters_from_format_id: true` under `oneOf`. Updated seller, creative, generative-seller, and retail-media skill examples; flagged `renders: [{ width, height }]` as the canonical wrong shape.
- `get_media_buys.media_buys[]`: `currency` and `total_budget` are now required per row. Seller skill example now shows both; added a persistence note (save these fields on `create_media_buy` so subsequent queries can echo them).
- `context` response field: schema-typed as `object`. Across all 8 skills, rewrote the "Context and Ext Passthrough" section to stop recommending `context: args.context` echo (which fabricates string values when `args.context` is undefined or confused with domain fields like `campaign_context`). Explicit guidance: leave the field out of your return — `createAdcpServer` auto-injects the request's context object; hand-setting a non-object string fails validation and the framework does not overwrite.
- Brand-rights governance flow: the `brand_rights/governance_denied` scenario expects the brand agent to call `check_governance` before issuing a license. Added `accounts: { syncAccounts, syncGovernance }` handlers and a `checkGovernance()` call in the `acquireRights` example, returning `GOVERNANCE_DENIED` with findings propagated from the governance agent.
- Seller idempotency section: referenced [adcontextprotocol/adcp-client#678](https://github.com/adcontextprotocol/adcp-client/issues/678) as a known grader-side limitation on the missing-key probe (MCP Accept header negotiation), so builders don't chase a skill fix for what's actually a grader issue.
