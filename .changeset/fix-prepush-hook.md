---
"@adcp/client": patch
---

Fix pre-push hook to skip slow tests by setting CI=true, matching GitHub Actions behavior and preventing unnecessary test timeouts during git push
