---
'@adcp/sdk': patch
---

Keep producer evidence and truthful discovery attribution when fixture preparation fails (#3385).

A `prepareStoryboardFixtures()` that ended in `disposition.failed` lost its evidence the moment an authorized `runStoryboard` / `runStoryboardStep` reused it, and the producer phase named the wrong task. Four fixes, all to failure output; no change to passing runs, counts, or the denial path.

- **The full run reports product discovery, not capability discovery.** Reusing a failed preparation returned the generic `discovery_failed` row — task `''`, no validations, `fixture_resolutions` dropped — which sent implementors to look at their transport and auth when the actual failure was `get_products`. It now returns a `prepared_fixtures_preparation_failed` step naming the real failing task, carrying the `fixture_capture_unbuildable` / `preparation_failed` check, republishing the producer phase with its original context and error, and keeping `fixture_resolutions`.
- **The standalone run carries the same records.** `runStoryboardStep` returns one step as the whole result, so `StoryboardStepResult` gains an optional `fixture_resolutions` for this case. It had none before: the caller was told preparation failed with no way to see which handle, which strategy, or what the seller returned.
- **The producer step names the task that actually ran.** `chosenStrategy` is only assigned when a strategy RESOLVES, so a discover-only handle that failed fell through to `comply_test_controller` — claiming a controller seed for a run whose only traffic was `get_products`. A handle abandoned because its parent failed makes no call at all and is now named by the strategy it declared, and carries no request record.
- **A failed discovery records its real exchange.** The request is captured before dispatch, so a transport failure still has it; protocol, schema, shape and pagination failures each cite the page that failed. A malformed page also emits a failing `response_schema` check with the schema id and url — the executor's strict-mode rejection used to hide whether a page was malformed or merely rejected. Nothing is fabricated: a response is recorded only when one arrived.

Unchanged: these remain failures, never `fixture_unsatisfied`; a denied caller still receives only `PreparedFixturesDeniedError`, with the complete record going to `prepared_fixtures_audit_sink`.
