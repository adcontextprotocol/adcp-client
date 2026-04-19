---
'@adcp/client': patch
---

**Idempotency storyboard end-to-end compliance** — the universal
`idempotency` compliance storyboard now passes 1/0/0/0 against agents
built from all 8 skills. Three framework fixes were required to get there:

1. **`replayed: false` on fresh executions.** Middleware now stamps the
   field on every mutating response, not just replays. Buyers that branch
   on `metadata.replayed` to decide whether side effects already fired
   need the field present either way. Cached envelopes are stamped after
   the save so replays cleanly overwrite with `true`.

2. **Replay echoes the current retry's `context`, not the first caller's.**
   Previously, cached response envelopes baked in the first caller's
   `correlation_id` and replays returned that to every subsequent retry,
   breaking end-to-end tracing. The middleware now strips `context` from
   the formatted response before caching; on replay, `finalize()`
   re-injects the current request's context.

3. **MCP-level `idempotency_key` relaxed to optional when the framework
   has an idempotency store wired.** The middleware is authoritative for
   this field and returns a structured `adcp_error` with `code` + `field`.
   If the MCP SDK's schema validator rejected first, buyers got a text-
   only `-32602` error that failed the storyboard's `error_code` check.

**Storyboard harness fixes** so the runner actually exercises replay semantics:

- `$generate:uuid_v4[#alias]` placeholder resolution in `sample_request`
  values. Same alias within a run → same UUID (enables initial + replay
  testing). Alias cache lives in a WeakMap keyed off context identity,
  propagated explicitly at shallow-clone sites via `forwardAliasCache` —
  no implementation-detail keys leak into serialized output.
- Request builders now forward `idempotency_key` from `sample_request`
  and respect future-dated `start_time`/`end_time` (two calls generated
  ms apart with `Date.now()` hash differently, triggering spurious
  CONFLICT on replay).
- `$context.<key>` placeholders now resolved in validation `value` and
  `allowed_values` so expected values can reference prior steps.
- New `TaskOptions.skipIdempotencyAutoInject` (`@internal` — compliance
  testing only) lets the runner exercise servers' missing-key validation
  without the client auto-generating a key. Gated at all three inject
  sites: `normalizeRequestParams`, `executeAndHandle` pre-validation,
  and `TaskExecutor.executeTask`.

**Skills**: wire `createIdempotencyStore` into the main Implementation
block for creative, signals, brand-rights, retail-media, and
generative-seller (seller/SI/governance were already complete). Extends
`test-agents/test-agent-build.sh` to all 8 agent types, adds the
universal idempotency storyboard as a second check, passes `--allow-http`.
