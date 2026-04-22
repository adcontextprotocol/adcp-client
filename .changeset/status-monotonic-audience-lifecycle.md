---
'@adcp/client': minor
---

Extend the bundled `status.monotonic` default assertion to track the audience lifecycle alongside the seven resource types it already guards (adcontextprotocol/adcp#2836). `sync_audiences` responses carry per-audience `status` values (`processing | ready | too_small`) drawn from the newly-named spec enum at `/schemas/enums/audience-status.json`, and the assertion now rejects off-graph transitions across storyboard steps for every observed `audience_id`.

**Transition graph** — fully bidirectional across the three states, matching the spec's permissive "MAY transition" hedging:

- `processing → ready | too_small` on matching completion.
- `ready ↔ processing` on re-sync (new members → re-match).
- `too_small → processing | ready` on re-sync (more members → re-match, directly back to ready when the re-matched count clears the minimum).
- `ready ↔ too_small` as counts cross `minimum_size` across re-syncs.

**Observations** are drawn from `sync_audiences` responses only — discovery-only calls (request omits the `audiences[]` array) still return `audiences[]`, so the extractor covers both write and read paths under the single task name. No separate `list_audiences` task exists in the spec. Actions `deleted` and `failed` omit `status` entirely on the response envelope; the extractor's id+status guard makes those rows silent (nothing to observe, nothing to check).

**Resource scoping** is `(audience, audience_id)`, independent from the other tracked resources. Unknown enum values drift-reset the anchor rather than failing — `response_schema` remains the gate for enum conformance.

8 new unit tests cover the forward flow, the too_small → processing → ready re-sync path, bidirectional `ready ↔ too_small`, `ready → processing` on re-sync, self-edge silent pass, deleted/failed silent pass, per-audience-id scoping, and enum-drift tolerance. The assertion description now enumerates `audience` alongside the other resource types.

Follow-up: wiring `audience-sync/index.yaml` with `invariants: [status.monotonic]` in the adcp spec repo once this release lands.
