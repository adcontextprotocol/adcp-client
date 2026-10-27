---
'@adcp/sdk': patch
---

Expose the trusted SDK-selected release as optional `TaskResult.metadata.wireAdcpVersion`, including same-release negotiation without changing request stamps or validation overrides. Account-change drains validate against that known wire contract before considering the seller's echo; a custom reader's explicit validation pin also takes precedence over an unverified echo. An older echo cannot relax 3.3 changed-path requirements when negotiation or an explicit wire override established the release. Sellers without authoritative release metadata retain the existing echo/client fallback.
