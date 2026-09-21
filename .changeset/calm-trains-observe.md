---
'@adcp/sdk': patch
---

Stop transport diagnostics scopes from waiting for asynchronous response-body capture. The `response_received` activity still fires when capture completes, but may now arrive after `withTransportDiagnostics()` resolves.
