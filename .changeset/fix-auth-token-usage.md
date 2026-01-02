---
"@adcp/client": patch
---

Fix getAuthToken() to use auth credentials when provided regardless of requiresAuth flag. The requiresAuth flag now only controls enforcement (throws in production if missing), not usage.
