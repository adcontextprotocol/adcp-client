---
"@adcp/client": patch
---

fix: strip buyer_ref before strict validation in validateRequest() to preserve backward compatibility with pre-4.15 servers
