---
"@adcp/client": patch
---

fix(testing): signals governance advisory block now fires correctly

The governance advisory check in `testSignalsFlow` was silently a no-op: it
re-parsed `signalsStep.response_preview` (a pre-formatted summary string) looking
for `.signals`/`.all_signals` keys that never exist in that format, so
`withRestrictedAttrs` and `withPolicyCategories` were always empty arrays.

`discoverSignals` now returns the raw `GetSignalsResponse.signals` array alongside
the digested `AgentProfile.supported_signals` array. The advisory block uses the
raw array directly and also evaluates signals discovered via the fallback-brief
loop, so agents whose first `get_signals` call returns empty are still graded.
The advisory hint now points operators at the spec-correct surface for declaring
`restricted_attributes`/`policy_categories` (the `signal_catalog` in
`adagents.json`).
