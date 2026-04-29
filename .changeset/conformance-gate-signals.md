---
"@adcp/sdk": patch
---

fix(conformance): remove incorrect get_products gate from error_handling, validation, schema_compliance scenarios

Signals-only agents were skipped entirely for three cross-cutting conformance
scenarios because SCENARIO_REQUIREMENTS listed get_products as a required tool.
All three scenarios apply to any agent regardless of tool family:

- error_handling and validation already use per-tool conditional guards
  internally; removing the outer gate lets them run for signals, creative,
  and governance agents with whatever steps apply to their toolset.
- schema_compliance gains a signals path: calls get_signals, validates
  GetSignalsResponse via Zod, and checks required field presence
  (signal_agent_segment_id, name, signal_type). Agents with neither
  get_products nor get_signals receive a graceful pass-with-warning.
