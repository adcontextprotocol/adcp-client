---
"@adcp/client": minor
---

Simplify authentication configuration by removing `requiresAuth` and `auth_token_env` fields.

**Breaking Changes:**
- `AgentConfig.requiresAuth` has been removed - if `auth_token` is provided, it will be used
- `AgentConfig.auth_token_env` has been removed - use `auth_token` directly with the token value

**Migration:**
```typescript
// Before
const config = {
  id: 'my-agent',
  agent_uri: 'https://agent.example.com',
  protocol: 'mcp',
  requiresAuth: true,
  auth_token_env: 'MY_TOKEN_ENV_VAR',  // or auth_token: 'direct-token'
};

// After
const config = {
  id: 'my-agent',
  agent_uri: 'https://agent.example.com',
  protocol: 'mcp',
  auth_token: process.env.MY_TOKEN_ENV_VAR,  // or 'direct-token'
};
```

The simplified model: if `auth_token` is provided, it's sent with requests. If not provided, no authentication is sent.
