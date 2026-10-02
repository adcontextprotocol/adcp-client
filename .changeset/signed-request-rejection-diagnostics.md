---
'@adcp/sdk': patch
---

Preserve HTTP 401 diagnostics for SDK-signed A2A and MCP requests instead of suggesting bearer tokens or OAuth. AuthenticationRequiredError carries the original status and signatureErrorCode, with protocol repair guidance and a bounded, redacted, non-enumerable responseBody for seller diagnostics. Explicit Signature-challenge rejections skip unsigned authentication probes and credential refresh retries. Bare signed 401s preserve the existing single client-credentials refresh before surfacing a persistent rejection; explicit gateway challenges retain existing authentication recovery. Unsigned Signature challenges also receive signing guidance.
