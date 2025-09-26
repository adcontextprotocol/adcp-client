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

### 3. MCP CLIENT AUTHENTICATION - CRITICAL
**🚨 AUTHENTICATION REQUIREMENTS 🚨**: 

1. **The MCP SDK automatically handles initialization** - The `connect()` method sends the `initialize` request internally
2. **Authentication must be provided via headers** - Use `requestInit.headers` to add `x-adcp-auth`:

```javascript
const transport = new StreamableHTTPClientTransport(url, {
  requestInit: {
    headers: {
      'x-adcp-auth': authToken
    }
  }
});
await client.connect(transport); // This automatically calls initialize internally
```

3. **Server authentication issues** - If you get "Missing or invalid x-adcp-auth header" errors even when providing the header, verify:
   - The auth token is correct and not expired
   - The server is properly handling the authentication headers
   - You're using the correct scope/API key for the server

### 4. ERROR HANDLING
- Show real errors from agents
- Don't mask failures with fake success responses
- Properly detect and report JSON-RPC errors
- If a protocol client throws an error, let it bubble up

### 5. FLY.IO DEPLOYMENT REQUIREMENTS - CRITICAL 🚨
**🚨 HOST/PORT CONFIGURATION REQUIREMENTS 🚨**:

1. **Server MUST listen on 0.0.0.0:8080 in production** - Fly.io requires this for external access
2. **Environment-specific host binding**:
   ```javascript
   const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
   const port = parseInt(process.env.PORT || '8080');
   ```
3. **Common deployment failure**: Server listening on `127.0.0.1` will cause "instance refused connection" errors
4. **Verification**: Check logs for `Server listening at http://0.0.0.0:8080` (not `127.0.0.1`)

**Files to check when deploying**:
- `src/server.ts` - Fastify server host/port configuration
- `server.js` - Express server host/port configuration (if used)
- `fly.toml` - Should have `internal_port = 8080`

## Recent Issues Fixed

### Server Host/Port Configuration Issue (2025-09-11)
**Problem**: Fly.io deployment failing with "instance refused connection" errors.

**Root Cause**: TypeScript server (`src/server.ts`) was configured to listen on `127.0.0.1:3000` by default instead of `0.0.0.0:8080` required by Fly.io.

**Solution**: Updated server configuration to use environment-specific host binding:
```javascript
// Before (BROKEN in production)
const port = parseInt(process.env.PORT || '3000');
const host = process.env.HOST || '127.0.0.1';

// After (WORKS in production) 
const port = parseInt(process.env.PORT || '8080');
const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
```

**Prevention**: Always verify server logs show `http://0.0.0.0:8080` in production, not `http://127.0.0.1`.

### Debug Logs "Unknown [undefined]" Issue (2025-09-09)
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

### Pre-Deployment Testing
When making changes, always verify:
- [ ] Debug logs show actual method names, not "Unknown [undefined]"
- [ ] Agents load correctly in the dropdown
- [ ] Products display (even if mock data)
- [ ] Formats display (even if mock data)
- [ ] No 404 errors in browser console
- [ ] Request/response pairs display correctly in debug panel
- [ ] **Server configuration**: Verify host/port settings for production deployment

### Deployment Testing (Fly.io)
Before and after deploying:
- [ ] **Pre-deploy**: Run `npm test` to ensure server configuration is correct
- [ ] **Pre-deploy**: Run `npm run build` locally to catch TypeScript errors
- [ ] **Pre-deploy**: Verify `src/server.ts` has correct host/port configuration
- [ ] **Post-deploy**: Check `fly logs -n | grep "Server listening"` shows `http://0.0.0.0:8080`
- [ ] **Post-deploy**: Test `curl -I https://adcp-testing.fly.dev` returns 200 OK
- [ ] **Post-deploy**: Verify `fly status` shows machine in "started" state with healthy checks

### Automated Tests
The project includes unit tests to prevent regression of critical deployment configurations:

- **Server Configuration Tests** (`test/server-config.test.js`):
  - Validates host binding logic for production vs development
  - Ensures correct port defaults for Fly.io compatibility
  - Tests environment variable override behavior
  - Run with: `npm run test:server-config`

**Important**: Always run `npm test` before deploying to catch configuration issues early.

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
The production `SALES_AGENTS_CONFIG` can contain various agent types:

**Option 1: AdCP Protocol Test Agents**
```json
{
  "agents": [
    {
      "id": "principal_3bd0d4a8_a2a",
      "name": "AdCP Test Agent",
      "agent_uri": "https://test-agent.adcontextprotocol.org",
      "protocol": "a2a",
      "auth_token_env": "<AUTH_TOKEN>",
      "requiresAuth": true
    },
    {
      "id": "principal_3bd0d4a8_mcp", 
      "name": "AdCP Test Agent",
      "agent_uri": "https://test-agent.adcontextprotocol.org/mcp/",
      "protocol": "mcp",
      "auth_token_env": "<AUTH_TOKEN>",
      "requiresAuth": true
    }
  ]
}
```

**Option 2: HITL Advertiser Agents (See PRODUCTION-HITL-AGENTS.md)**
```json
{
  "agents": [
    {
      "id": "sync_hitl_advertiser_a2a",
      "name": "Automatic Approval - A2A (10s delay)",
      "agent_uri": "https://test-agent.sales-agent.scope3.com",
      "protocol": "a2a",
      "auth_token_env": "SYNC_HITL_ADVERTISER_TOKEN",
      "requiresAuth": true
    },
    {
      "id": "sync_hitl_advertiser_mcp",
      "name": "Automatic Approval - MCP (10s delay)",
      "agent_uri": "https://test-agent.sales-agent.scope3.com/mcp/",
      "protocol": "mcp",
      "auth_token_env": "SYNC_HITL_ADVERTISER_TOKEN",
      "requiresAuth": true
    },
    {
      "id": "async_hitl_advertiser_a2a",
      "name": "Async HITL Advertiser - A2A (125s timeout)",
      "agent_uri": "https://test-agent.sales-agent.scope3.com",
      "protocol": "a2a",
      "auth_token_env": "ASYNC_HITL_ADVERTISER_TOKEN",
      "requiresAuth": true
    },
    {
      "id": "async_hitl_advertiser_mcp",
      "name": "Async HITL Advertiser - MCP (125s timeout)",
      "agent_uri": "https://test-agent.sales-agent.scope3.com/mcp/",
      "protocol": "mcp",
      "auth_token_env": "ASYNC_HITL_ADVERTISER_TOKEN",
      "requiresAuth": true
    }
  ]
}
```

### Common Tasks

#### Update Agent Configuration
When you need to change agents, auth tokens, or URIs:

```bash
# Single line format for terminal (replace <AUTH_TOKEN> with actual token)
fly secrets set SALES_AGENTS_CONFIG='{"agents":[{"id":"principal_3bd0d4a8_a2a","name":"AdCP Test Agent","agent_uri":"https://test-agent.adcontextprotocol.org","protocol":"a2a","auth_token_env":"<AUTH_TOKEN>","requiresAuth":true},{"id":"principal_3bd0d4a8_mcp","name":"AdCP Test Agent","agent_uri":"https://test-agent.adcontextprotocol.org/mcp/","protocol":"mcp","auth_token_env":"<AUTH_TOKEN>","requiresAuth":true}]}'
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
  - AdCP Test Agent (A2A) at https://test-agent.adcontextprotocol.org  
  - AdCP Test Agent (MCP) at https://test-agent.adcontextprotocol.org/mcp/
🔧 Real agents mode: ENABLED
```

#### Common Issues

1. **"Instance refused connection" / Deployment fails**: 
   - **Cause**: Server listening on `127.0.0.1` instead of `0.0.0.0`
   - **Fix**: Update server configuration to use environment-specific host binding
   - **Verify**: Check logs for `Server listening at http://0.0.0.0:8080`
   ```bash
   fly logs -n | grep "Server listening"  # Should show 0.0.0.0:8080, not 127.0.0.1
   ```

2. **Secret update timeout**: If `fly secrets set` times out, check if it completed:
   ```bash
   fly secrets list  # check if digest changed
   fly logs -n       # check if app restarted with new config
   ```

3. **Agent not responding**: Check agent health:
   ```bash
   curl -I https://test-agent.adcontextprotocol.org
   curl -I https://test-agent.adcontextprotocol.org/mcp/
   ```

4. **Authentication issues**: Verify auth token in agent config and ensure `requiresAuth: true`

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

## NPM Publishing & Release Management

### 🚨 CRITICAL: GitHub Release vs Git Tag 🚨

**IMPORTANT**: This project uses GitHub Actions for automatic npm publishing. The workflow is triggered by **GitHub Releases**, NOT git tags.

#### Correct Release Process:
1. **Create GitHub Release** (not just a git tag)
   - Use `gh release create v0.x.x` command
   - Or create release via GitHub web interface
   - This triggers the CI/CD workflow automatically

2. **Workflow Trigger**: 
   - The publish job runs on `github.event_name == 'release' && github.event.action == 'published'`
   - Located in `.github/workflows/ci.yml` lines 154-186

#### Common Mistake:
- ❌ **Wrong**: `git tag v0.x.x && git push origin v0.x.x` (only creates tag)
- ✅ **Correct**: `gh release create v0.x.x` (creates tag AND release)

#### Release Commands:
```bash
# Create release (this will trigger npm publish automatically)
gh release create v0.2.3 --title "v0.2.3" --notes "Release v0.2.3"

# Check if release triggered the workflow
gh run list --event=release

# Monitor workflow progress
gh run watch
```

#### Verification:
After creating a GitHub release, verify:
- [ ] GitHub Actions workflow runs automatically
- [ ] Package is published to npm registry
- [ ] Version appears at https://npmjs.com/package/@adcp/client

**Remember**: Always use GitHub releases for triggering npm publishing, not just git tags.

---

*Last updated: 2025-09-26 (Added NPM publishing and release management section)*
*Project: AdCP Testing Framework*
*Environment: Fly.io Production*