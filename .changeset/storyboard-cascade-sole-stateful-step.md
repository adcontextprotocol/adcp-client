---
"@adcp/sdk": patch
---

Fix storyboard runner cascade over-firing for sole-stateful-step phases (adcp-client#1144).

The F6 cascade-skip fix (6.1.0) deferred `not_applicable` cascade decisions to phase end, checking whether any peer stateful step established substitute state. This worked for snap (`sync_accounts: not_applicable` + `list_accounts: passes`) but still cascaded for adapters with a single stateful step in the phase and no peer-substitute (citrusad, amazon, criteo, google showing `1/9/0` on `sales_social`).

The cascade now only fires when the phase contained **other stateful peer steps** that could have established substitute state but didn't. When the `not_applicable` step is the sole stateful step in the phase, no cascade fires — the platform manages state implicitly through a different model, which is valid per AdCP protocol semantics.
