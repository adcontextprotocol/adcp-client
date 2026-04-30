---
'@adcp/sdk': patch
---

Pre-ship deep fixes from Emma matrix run 2 — three skill corrections + two framework guards driven by patterns LLMs scaffolded incorrectly when building agents from skills.

- **Signals skill**: typed the `signals` array as `GetSignalsResponse['signals']` so the LLM-scaffolded `signal_agent_segment_id` field can't be silently omitted. Strict response validation already rejects malformed signals at runtime in dev/test; this surfaces the contract at the LLM's first touchpoint.
- **`autoStoreResources`**: log a warning when records are skipped because the required id field (`signal_agent_segment_id`, `product_id`, etc.) is missing — silently skipping leaves buyers unable to reference the resource on a downstream mutating call, and is a strong indicator the publisher returned a misshaped response.
- **SI skill**: removed the phantom `SponsoredIntelligencePlatform` import and the invalid `'sponsored-intelligence'` specialism declaration (`AdCPSpecialism` does not include SI — it's a *protocol*, declared via `supported_protocols`). Skill now points adopters at the v5 `createAdcpServer` from `@adcp/sdk/server/legacy/v5` (the only path that ships SI dispatch today) with explicit `ctx.store.put('session', ...)` / `ctx.store.get('session', ...)` for session state. SI specialism + auto-hydration of `req.session` is a v6.x follow-up.
- **`call-adcp-agent` skill**: documented the upstream MCP transport quirk — `Accept: application/json, text/event-stream` is required by `@modelcontextprotocol/sdk`'s Streamable HTTP transport. A naive `fetch()` with only `Accept: application/json` gets `406 Not Acceptable` before any AdCP framing runs. Added a Symptom→Fix row pointing at the official client.
- **`createMediaBuy` HITL guard**: framework now rejects hand-rolled `{status: 'submitted', task_id}` returns from the sales/creative specialism handlers with a clear error pointing at `ctx.handoffToTask(fn)`. The framework owns the submitted envelope; bare submitted-shape returns skipped the task registry, leaving buyers polling task_ids the framework never registered.
