---
"@adcp/client": minor
---

feat(testing): add rawA2aProbe for A2A transport-layer storyboard diagnostics

Adds `rawA2aProbe({ agentUrl, method, params?, headers?, allowPrivateIp? })` to
`src/lib/testing/storyboard/probes.ts`, mirroring `rawMcpProbe` for agents
exposed over the A2A transport. Returns `{ httpResult: HttpProbeResult;
taskResult?: TaskResult }` so the storyboard `ValidationContext` can consume both
probes interchangeably. Surfaces raw JSON-RPC error codes (including A2A-specific
`-32002 TaskNotCancelable`) without protocol aliasing.
