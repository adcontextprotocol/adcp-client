---
'@adcp/sdk': minor
---

Expose `resolveCreativeFormatWireMode(taskType, options)` on `AgentClient` and `SingleAgentClient` so buyers can preflight the same capabilities, tool-schema fallback, and wire-version pin used by creative writes. Reuse cached or primed capability evidence and preserve existing capability errors and conservative `unknown` behavior for older peers. Scoped discovery uses the current transport's tool schema.
