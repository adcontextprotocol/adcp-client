---
"@adcp/client": patch
---

Fix ext field being incorrectly stripped from v2 server requests. ext is a protocol-level extension field valid in all AdCP versions and should always be preserved.
