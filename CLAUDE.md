# AdCP Testing Framework - Development & Deployment Guide

## 🚨 CRITICAL REQUIREMENTS - MUST FOLLOW 🚨

### 1. ALWAYS USE OFFICIAL PROTOCOL CLIENTS
- **A2A Protocol**: ALWAYS use the official `@a2a-js/sdk` client
- **MCP Protocol**: ALWAYS use the official `@modelcontextprotocol/sdk` client  
- **NEVER** implement custom HTTP fallbacks or protocol implementations
- **NEVER** parse SSE responses manually
- **NEVER** make direct fetch() calls to agent endpoints
- If an official client fails to import, FIX THE IMPORT - don't create workarounds

### 2. NEVER USE MOCK DATA
- **NEVER** inject mock products, formats, or any other fake data
- **NEVER** provide fallback data when agents return empty responses
- **ALWAYS** return exactly what the agents provide
- If an agent returns empty arrays or errors, show that to the user
- Real data only - no exceptions

### 3. ERROR HANDLING
- Show real errors from agents
- Don't mask failures with fake success responses
- Properly detect and report JSON-RPC errors
- If a protocol client throws an error, let it bubble up

## Recent Issues Fixed (2025-09-09)

### Debug Logs "Unknown [undefined]" Issue
**Problem**: UI displayed "Unknown [undefined]" instead of actual method names in debug logs.

**Root Causes**:
1. **Data Format Mismatch**: Backend returned debug logs as single object with `request` and `response` properties, but UI expected separate entries with `type` field
2. **API Response Structure**: UI expected `result.data.agents` but API returned just `result.agents`
3. **Parameter Name Mismatch**: UI sent `toolName` and `brandStory` but server expected `tool_name` and `brief`
4. **Default Agent IDs**: UI had hardcoded agent IDs that didn't match actual configured agents

**Solutions Applied**:
1. Transform debug logs in `/api/sales/agents/:agentId/query` endpoint to split into separate request/response entries with `type` field
2. Fixed UI to correctly parse API response structure (`result.data.agents`)
3. Server now accepts both parameter name formats
4. UI now dynamically loads agents from API instead of using hardcoded defaults

### Empty Products/Formats Issue
**Problem**: Live AdCP agent returns empty arrays for products and formats.

**Solution**: Return exactly what the agent provides - empty arrays are valid responses. NO MOCK DATA.

## Critical Code Patterns to Maintain

### Debug Log Format (DO NOT CHANGE)
The UI expects debug logs in this specific format:
```javascript
[
  {
    type: 'request',
    method: 'tool_name',
    protocol: 'a2a' | 'mcp',
    url: 'agent_url',
    headers: {},
    body: 'request_body',
    timestamp: 'ISO_string'
  },
  {
    type: 'response',
    status: 'status_code',
    statusText: 'status_text',
    body: response_data,
    timestamp: 'ISO_string'
  }
]
```

### API Response Structure
The `/api/sales/agents` endpoint must return:
```javascript
{
  success: true,
  data: {
    agents: [...],
    total: number
  },
  timestamp: 'ISO_string'
}
```

### Parameter Name Handling
Always accept both formats:
- `tool_name` OR `toolName`
- `brief` OR `brandStory`
- `promoted_offering` OR `offering`

## Common Pitfalls to Avoid

1. **Never use hardcoded agent IDs** - Always fetch from API
2. **Don't assume data structure** - Always check nested response formats
3. **Handle both parameter naming conventions** - UI and API may use different styles
4. **Always transform debug logs** - Backend and UI formats differ
5. **Check for undefined before length** - Use `(!data || data.length === 0)` not just `data.length === 0`

## Testing Checklist

When making changes, always verify:
- [ ] Debug logs show actual method names, not "Unknown [undefined]"
- [ ] Agents load correctly in the dropdown
- [ ] Products display (even if mock data)
- [ ] Formats display (even if mock data)
- [ ] No 404 errors in browser console
- [ ] Request/response pairs display correctly in debug panel

## Project Overview
This is an AdCP (Advertising Protocol) testing framework deployed on Fly.io that supports both A2A and MCP protocols for testing advertising agents.

## Fly.io Deployment Management

### App Information
- **App Name**: `adcp-testing`
- **URL**: https://adcp-testing.fly.dev
- **Region**: iad (US East)

### Essential Commands

#### Check App Status
```bash
fly status
fly logs -n  # recent logs (no tail)
fly logs     # live tail
```

#### Secrets Management
```bash
# List all secrets
fly secrets list

# Update agent configuration (most common task)
fly secrets set SALES_AGENTS_CONFIG='{"agents": [...]}'

# Check if real agents mode is enabled
fly secrets list | grep USE_REAL_AGENTS
```

#### Deployment
```bash
# Deploy current code
fly deploy

# Deploy with build logs
fly deploy --verbose
```

### Current Production Configuration

#### Secrets
- **SALES_AGENTS_CONFIG**: Contains JSON array of agent configurations
- **USE_REAL_AGENTS**: Set to enable production agents (vs test/demo agents)

#### Production Agent Configuration
The production `SALES_AGENTS_CONFIG` should contain:

```json
{
  "agents": [
    {
      "id": "principal_3bd0d4a8_a2a",
      "name": "AdCP Test Agent",
      "agent_uri": "https://adcp-sales-agent.fly.dev",
      "protocol": "a2a",
      "auth_token_env": "L4UCklW_V_40eTdWuQYF6HD5GWeKkgV8U6xxK-jwNO8",
      "requiresAuth": true
    },
    {
      "id": "principal_3bd0d4a8_mcp", 
      "name": "AdCP Test Agent",
      "agent_uri": "https://adcp-sales-agent.fly.dev/mcp/",
      "protocol": "mcp",
      "auth_token_env": "L4UCklW_V_40eTdWuQYF6HD5GWeKkgV8U6xxK-jwNO8",
      "requiresAuth": true
    }
  ]
}
```

### Common Tasks

#### Update Agent Configuration
When you need to change agents, auth tokens, or URIs:

```bash
# Single line format for terminal
fly secrets set SALES_AGENTS_CONFIG='{"agents":[{"id":"principal_3bd0d4a8_a2a","name":"AdCP Test Agent","agent_uri":"https://adcp-sales-agent.fly.dev","protocol":"a2a","auth_token_env":"L4UCklW_V_40eTdWuQYF6HD5GWeKkgV8U6xxK-jwNO8","requiresAuth":true},{"id":"principal_3bd0d4a8_mcp","name":"AdCP Test Agent","agent_uri":"https://adcp-sales-agent.fly.dev/mcp/","protocol":"mcp","auth_token_env":"L4UCklW_V_40eTdWuQYF6HD5GWeKkgV8U6xxK-jwNO8","requiresAuth":true}]}'
```

#### Toggle Real vs Demo Agents
```bash
# Enable real agents (production mode)
fly secrets set USE_REAL_AGENTS=true

# Disable real agents (demo mode)
fly secrets unset USE_REAL_AGENTS
```

#### Restart App
```bash
fly machine restart $(fly machine list --quiet)
```

#### View Machine Details
```bash
fly machine list
fly machine status <machine-id>
```

### Monitoring & Troubleshooting

#### Check Agent Configuration
After deployment, verify in logs:
```bash
fly logs -n | grep "Configured agents"
```

Should show:
```
📡 Configured agents: 2
  - AdCP Test Agent (A2A) at https://adcp-sales-agent.fly.dev  
  - AdCP Test Agent (MCP) at https://adcp-sales-agent.fly.dev/mcp/
🔧 Real agents mode: ENABLED
```

#### Common Issues

1. **Secret update timeout**: If `fly secrets set` times out, check if it completed:
   ```bash
   fly secrets list  # check if digest changed
   fly logs -n       # check if app restarted with new config
   ```

2. **Agent not responding**: Check agent health:
   ```bash
   curl -I https://adcp-sales-agent.fly.dev
   curl -I https://adcp-sales-agent.fly.dev/mcp/
   ```

3. **Authentication issues**: Verify auth token in agent config and ensure `requiresAuth: true`

### File Structure
- `fly.toml` - Fly.io configuration
- `server.js` - Main application entry point  
- `src/server.ts` - TypeScript server source
- `src/protocols.ts` - Protocol handling (A2A, MCP)
- `src/public/` - Static web UI files
- `scripts/deploy.sh` - Deployment helper script

### Development vs Production
- **Development**: Uses local test agents or demo endpoints
- **Production**: Uses real agents with authentication via `USE_REAL_AGENTS=true`

### Security Notes
- Auth tokens are stored in Fly secrets (not in code)
- Tokens can be direct values (50+ chars) or environment variable names
- Real agent mode should only be enabled in production
- Never commit actual auth tokens to version control

---

*Last updated: 2025-09-04*
*Project: AdCP Testing Framework*
*Environment: Fly.io Production*