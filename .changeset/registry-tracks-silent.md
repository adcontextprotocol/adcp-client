---
'@adcp/sdk': patch
---

Adds `tracks_silent?: integer` to the `ComplianceRun` registry schema (`schemas/registry/registry.yaml`) so the AgenticAdvertising.org registry can persist and surface silent-track counts. Optional for back-compat with runs serialized before SDK 6.4.

Companion to the silent-track work in #1163. The SDK already emits `tracks_silent` in `ComplianceSummary` and tolerates its absence on read; this PR closes the registry-spec gap so dashboards consuming `ComplianceRun` can render silent rows distinctly. Server-side persistence of the new column is out of scope here — it's tracked in the upstream registry repo.
