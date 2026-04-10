---
"@adcp/client": patch
---

fix: comply runner sends account.sandbox: true in test controller requests

comply_test_controller request builder now injects account with sandbox: true so the training agent does not return FORBIDDEN during deterministic testing
