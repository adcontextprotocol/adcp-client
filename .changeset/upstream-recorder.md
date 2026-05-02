---
'@adcp/sdk': minor
---

feat(upstream-recorder): producer-side reference middleware for `query_upstream_traffic` adopters (closes adcp-client#1290)

New public sub-export `@adcp/sdk/upstream-recorder` — a small, sandbox-only-by-default helper adopters drop into their HTTP layer to populate the `comply_test_controller`'s `query_upstream_traffic` buffer that the runner-output-contract v2.0.0 `upstream_traffic` storyboard check (PR #1289, spec adcontextprotocol/adcp#3816) reads from.

The runner-side consumer landed in #1289. This is the producer-side companion: turns "instrument my outbound HTTP layer with a session/principal-scoped ring buffer + redaction + sandbox gating + multi-tenant isolation" — a 1-2 sprint engineering ask for a DSP/SSP-scale codebase — into "wire `recorder.wrapFetch(globalThis.fetch)` and pass the query result through your controller handler."

```ts
import { createUpstreamRecorder } from '@adcp/sdk/upstream-recorder';

const recorder = createUpstreamRecorder({
  enabled: process.env.NODE_ENV !== 'production',
});

// Wrap your HTTP layer
const fetch = recorder.wrapFetch(globalThis.fetch);

// Scope every outbound call inside a request handler to the resolving principal
await recorder.runWithPrincipal(account.id, async () => {
  await syncAudienceUpstream(/* ... */);
});

// In your `comply_test_controller` `query_upstream_traffic` handler:
const { items, total, truncated, since_timestamp } = recorder.query({
  principal: account.id,
  sinceTimestamp: req.params.since_timestamp,
  endpointPattern: req.params.endpoint_pattern,
  limit: req.params.limit,
});
return { success: true, recorded_calls: items, total_count: total, truncated, since_timestamp };
```

**Key behaviors** (all from the spec PR's three-expert review):

- **Per-principal isolation** (security HIGH from spec review). `query({ principal })` returns only calls bound to the same principal — multi-tenant sandboxes can't leak traffic across tenants. Adopters thread principal via `runWithPrincipal(p, fn)` (an AsyncLocalStorage scope that propagates across `await` boundaries) or pass it explicitly to `record()`.
- **Record-time redaction**. The canonical secret-key pattern from `runner-output-contract.yaml`'s `payload_redaction` is applied at recording time, not query time, so plaintext secrets never sit in the buffer in memory even briefly. Adopters MAY widen the pattern via `redactPattern` (extend the contract floor with internal vendor keys) but MUST NOT narrow it.
- **Sandbox-only gating**. `enabled: false` returns a no-op recorder — `wrapFetch` returns the input fetch unchanged, `record` is a no-op, `query` returns empty results. Zero per-call overhead in production.
- **Ring buffer + TTL eviction**. Default `bufferSize: 1000`, `ttlMs: 1h`. Old entries are pruned eagerly on the next record, then again on each query, so a stale recorder doesn't surface yesterday's traffic on today's compliance run.
- **`endpointPattern` glob filter**. `*` → `.*` (greedy, `/`-crossing); all other regex metas escape literally. Matches the runner's candidate `endpoint_pattern` semantics in `validations.ts` so producer + consumer agree.
- **`purpose` classifier hook**. Optional callback invoked at record time with `{method, url, host, path, headers}` (headers already redacted). Returning a string stamps `RecordedCall.purpose` — forward-compat for adcp#3830 item 3 (purpose / category tagging).
- **Manual `record()` escape hatch** for adopters with custom transports the recorder doesn't ship a wrapper for. Auto-fills timestamp, host/path, content_type, applies redaction, runs the purpose classifier.

**Refactor under the hood**: `redactSecrets` and `SECRET_KEY_PATTERN` lifted from the runner into a shared `src/lib/utils/redact-secrets.ts` so the new recorder reuses the same redaction floor as the runner consumes — adopter-emitted recorded payloads land in the runner's compliance report unchanged. No behavior change for the runner; `__redactSecretsForTest` still works.

19 tests in `test/lib/upstream-recorder.test.js` pin: enabled-false short-circuit, cross-principal isolation (the security HIGH), record-time JSON + header redaction with custom-pattern extension, ring buffer FIFO eviction, TTL eviction, endpointPattern + sinceTimestamp + limit/truncated query filters, wrapFetch end-to-end (incl. status_code capture and recording on fetch error), purpose classifier including the catches-throws-MUST-NOT-crash invariant, clear() cleanup helper.

**Sequencing note** — adcp#3830 item 4 in the deferred-extensions tracking issue, sequencing dependency from issue #1290: "land #1253 first (runner + forward-compat default) so storyboards can declare `upstream_traffic` validations and have them grade not_applicable on adopters who haven't yet implemented." That's now landed (PR #1289 merged at `c446936c`). This middleware unblocks the long tail of adopters who want to opt in but don't want to write the recorder from scratch.

Sibling Python issue: `adcp.testing.upstream_recorder` mirrors this for the Python SDK — to be filed as a paired issue in `adcontextprotocol/adcp-client-python`.
