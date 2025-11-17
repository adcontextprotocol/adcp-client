---
"@adcp/client": patch
---

Added explicit auth_token field and fixed auth_token_env to properly support environment variable lookup. AgentConfig now supports two authentication methods: auth_token (direct value) and auth_token_env (environment variable name). This fixes the issue where environment variable names were being sent as authentication tokens instead of being resolved.
