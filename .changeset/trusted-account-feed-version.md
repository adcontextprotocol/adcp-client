---
'@adcp/sdk': patch
---

Expose the trusted SDK-selected release as optional `TaskResult.metadata.wireAdcpVersion`, including same-release negotiation. Account-change drains validate against that trusted wire contract before considering the seller's echo; a custom reader's explicit validation pin also takes precedence over an unverified echo. A seller cannot relax 3.3 changed-path requirements by echoing an older release.
