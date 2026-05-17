---
'@adcp/sdk': minor
---

testing(impairment.coherence): emit `not_applicable` step result for deferred-inverse families

When a storyboard transitions an `audience`, `catalog_item`, or `event_source`
resource into its offline status (`suspended` / `withdrawn` / `insufficient`),
the runner now emits a step-level `AssertionResult` with `status: 'not_applicable'`
and a structured `ImpairmentCoherenceNotApplicableHint`:

```ts
{
  assertion_id: 'impairment.coherence',
  status: 'not_applicable',
  passed: true,
  step_id: '<transition step>',
  hint: {
    kind: 'impairment_coherence_not_applicable',
    violation: 'inverse',
    reason: 'resource_traversal_deferred',
    resource_type: 'audience' | 'catalog_item' | 'event_source',
    resource_id: '<id>',
    resource_status: '<offline value>',
    resource_step_id: '<transition step>',
    message: '... Tracked in adcontextprotocol/adcp#2860.',
  },
}
```

Before this change, the inverse-rule evaluator silently skipped these three
families (a storyboard that suspended an audience and read a buy missing it
from `impairments[]` would pass silently). The forward rule already grades
them and is unchanged; the inverse rule still defers to the larger
`adcp#2860` work, but the gap is now visible in run output instead of buried
in PR prose.

Single emission per `(resource_type, resource_id)` per run — re-syncs of an
already-offline resource don't re-fire. Recovery followed by a new offline
transition does re-fire. The existing `onEnd` run-level deferred-coverage
notice still emits the family-level aggregate.

API additions:

- `AssertionResult.status` gains `'not_applicable'` as a fourth value
  (previously `'pass' | 'silent' | 'fail'`).
- New `ImpairmentCoherenceNotApplicableHint` member added to the
  `StoryboardStepHint` discriminated union (`kind: 'impairment_coherence_not_applicable'`),
  exported from `@adcp/sdk/testing`.

Closes adcp-client#1806. Inverse-rule coverage itself is still tracked by
adcontextprotocol/adcp#2860.
