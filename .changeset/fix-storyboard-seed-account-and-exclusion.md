---
"@adcp/sdk": patch
---

Scope automatic product and pricing-option fixtures to the account used by the
storyboard's effective public requests, retaining complete natural identity or an
opaque account reference across ordinary, routed and fixture-resolution seeds.
Resolve run-brand overrides, context inputs, provisioning account aliases and
later timezone enrichment consistently; refuse ambiguous or unresolved account
scope. Independent account provisioning seeds retain their existing targets.
Include operator unit, currency and timezone in the server's natural-account seed
cache scope so one account cannot reuse another account's fixture cache entries.

Preserve provenance creative_policy.accepted_verifiers agent URLs when stripping
legacy creative-format identity, including URLs shared with a format provider.

Preserve complete account identity through the platform controller wrapper and
refuse catalog auto-seeds without a resolved account instead of reporting a
successful fixture write after dropping it.

Preserve the optional open controller account carrier at MCP ingress so full
identity reaches per-request store factories without rejecting valid AdCP 3.0
requests. AdCP 3.1 callers still supply their required sandbox assertion.
