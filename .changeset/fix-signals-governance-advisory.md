---
"@adcp/client": patch
---

fix(testing): signals governance advisory block now fires correctly

The governance advisory check in `testSignalsFlow` was silently a no-op: it
re-parsed `signalsStep.response_preview` (a pre-formatted summary string) looking
for `.signals`/`.all_signals` keys that never exist in that format, so
`withRestrictedAttrs` and `withPolicyCategories` were always empty arrays.

`discoverSignals` now returns the raw `GetSignalsResponse.signals` array alongside
the digested `AgentProfile.supported_signals` array. The governance block uses the
raw array directly, allowing `restricted_attributes` and `policy_categories`
extension fields to be evaluated correctly.
