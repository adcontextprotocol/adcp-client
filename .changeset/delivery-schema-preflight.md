---
'@adcp/sdk': patch
---

Prepare artifact-delivery webhook validators before signature verification. Missing or ambiguous schema configuration returns `webhook_verification_unavailable` without consuming a valid signature nonce, so correcting configuration permits retrying the original signed bytes. Preserve existing creative-conversion advisories when transferring diagnostics onto an already projected object.
