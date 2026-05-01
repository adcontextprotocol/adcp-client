---
'@adcp/sdk': minor
---

Client-side response validation now defaults to `warn` everywhere — previously `strict` in dev/test, `warn` only in production. Drift surfaces through `result.debug_logs` and the response payload reaches the caller; the task no longer fails just because a seller's response missed an optional schema constraint.

**Why.** With #1137's version-pinned validator, a v2.5 seller's perfectly valid v2.5-shaped response is now correctly validated against the v2.5 schema — but v2.5 schemas have wider drift tolerance (envelope nulls, optional-but-required-in-schema fields like `pricing_options`, enum mismatches) than the modern v3 spec. Strict-by-default in dev/test meant integration tests against legitimate v2.5 sellers turned every minor schema gap into a hard failure with `result.data` thrown away — leaving callers staring at "0 products" with no useful signal. `warn` keeps the data flowing and surfaces the drift through the existing `debug_logs` channel that #1133 wired up.

**Server-side unchanged.** `createAdcpServer` still defaults its handler-side validation to `strict` in dev/test/CI. That catches our own handler-output bugs, which strict mode is genuinely good at — distinct from the client-side concern of "seller wrote a slightly off-spec response."

**Opt back in.** Buyers who want hard-stop response validation (conformance harnesses, third-party validators, paranoid CI runs) pass `validation: { responses: 'strict' }` explicitly:

```ts
new AgentClient({
  agent_uri: '...',
  validation: { responses: 'strict' },
});
```

Closes adcontextprotocol/adcp-client#1150.
