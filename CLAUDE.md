# AdCP Testing Framework - Deployment Management

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