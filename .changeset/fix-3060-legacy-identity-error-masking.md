---
'@adcp/sdk': patch
---

fix(client): stop `stripLegacyCreativeIdentity` masking seller error text as `[legacy creative identity]` (#3060)

The canonical creative boundary treated the SDK-synthesized `_message` (the seller's text part) as a source of legacy identity tokens, so the seller's whole error sentence was scrubbed from `result.error`, `result.adcpError.message`, and `result.data.adcp_error.message` on failed `get_products` (and other canonical creative) calls. `_message` is still dropped from canonical output, but its prose is no longer tokenized. Error text is only masked where it actually carries a legacy creative identity (`format_id`, `v1_format_ref`, `agent_url`, or a value/URL collected from a real identity field).
