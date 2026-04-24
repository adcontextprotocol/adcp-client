---
"@adcp/client": minor
---

`runStoryboardStep` now accepts and emits `context_provenance` so LLM-orchestrated step-by-step runs can thread rejection-hint provenance across calls the same way `context` already flows. Closes adcp-client#880. Before this, stateless step calls always initialized an empty provenance map and `context_value_rejected` hints never fired on that surface.

- `StoryboardRunOptions.context_provenance?: Record<string, ContextProvenanceEntry>` — seeds the map.
- `StoryboardStepResult.context_provenance?: Record<string, ContextProvenanceEntry>` — full accumulated map after this step's own writes are applied. Absent when empty.

Full `runStoryboard` behavior is unchanged (it builds the map internally; the field still surfaces on each step result for consumers reading compliance reports).
