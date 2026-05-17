---
'@adcp/sdk': minor
---

feat(testing): register `impairment.coherence` storyboard assertion

Wires the cross-resource invariant defined in adcp#2859 (spec PR
adcontextprotocol/adcp#4601) into the SDK's storyboard runner. Without this
registration, storyboards that declare `invariants: [impairment.coherence]`
fail to load with an unregistered-assertion error — the immediate blocker
for the three creative-* specialisms (`creative-ad-server`, `creative-template`,
`creative-generative`) that the spec PR deferred wiring on.

The assertion checks three coherence rules over every run:

- **Forward.** Each entry in `media_buy.impairments[]` MUST reference a
  resource whose last observed status is an offline value for its family
  (audience → `suspended`, creative → `rejected`, catalog_item →
  `withdrawn`, event_source → `insufficient`). Silent when the runner has
  no observation for the referenced resource.
- **Inverse (creative).** Any creative the run transitioned to `rejected`
  AND that is referenced by a non-terminal buy via
  `packages[].creative_assignments[].creative_id` MUST appear in that
  buy's `impairments[]`. Buys in `completed`, `canceled`, or `rejected`
  status are exempt. Audience / catalog / event-source inverse coverage
  is deferred until per-buy reference shapes stabilise (tracked in
  adcp#2860).
- **Health-iff-impairments.** `media_buy.health == "impaired"` iff
  `impairments[]` is non-empty. Silent when the seller omits `health`.

Registered with `default: true` so every storyboard inherits the check;
disable per-storyboard via `invariants: { disable: ['impairment.coherence'] }`.
Grades silent (no observations) on runs that never exercise both sides —
the spec issue's "not_applicable" carve-out for storyboards that don't
exercise the cross-resource path.

Adds a structured `ImpairmentCoherenceHint` (kind:
`impairment_coherence_violation`, discriminator `violation: 'forward' |
'inverse' | 'health'`) to the `StoryboardStepHint` union so renderers can
branch on the violation shape without parsing prose.

Property-typed impairments grade silent — depublishing flows through
`brand.json` / `adagents.json` updates, not a resource-status enum the
runner can observe via task responses. The spec issue explicitly carves
this out.

Resource-status observations come from a dedicated extractor
(`extractImpairmentObservations`) keyed on `sync_creatives` /
`list_creatives`, `sync_audiences`, `sync_catalogs` / `list_catalogs`,
and `sync_event_sources` — independent of `status.monotonic` because
the new offline values (`suspended`, `withdrawn`, `insufficient`) sit
outside monotonic's transition graphs and would otherwise be invisible
to the forward rule. Disabling `status.monotonic` has no effect on this
assertion. Per-run scratch state is namespaced under
`ctx.state.impairmentCoherence` to avoid colliding with other
assertions that share the same context bag.

Health-iff check honors the spec's terminal-buy carve-out: skipped on
`completed` / `canceled` / `rejected` buys (where the seller may have
stopped tracking impairments) and on snapshots that omit `health`
entirely.

Follow-up: spec repo re-enables `impairment.coherence` wiring on
`creative-ad-server`, `creative-template`, and `creative-generative`
specialism yamls (deferred inline notes in adcp#4601).
