# Production HITL Test Agents Configuration

## 🔒 Security-First Agent Configuration

### Environment Variables Setup

**Create these environment variables in your production environment:**

```bash
# Async HITL Advertiser Token (125s timeout)
ASYNC_HITL_ADVERTISER_TOKEN="your_async_hitl_token_here"

# Sync HITL Advertiser Token (10s delay)  
SYNC_HITL_ADVERTISER_TOKEN="your_sync_hitl_token_here"
```

### Full Production Configuration

**A2A + MCP Variants for Both Sync and Async:**

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

## 🚀 Deployment Commands

### Fly.io Production Deployment

**Step 1: Set Environment Variables**
```bash
# Set the auth tokens as Fly secrets
fly secrets set ASYNC_HITL_ADVERTISER_TOKEN="your_async_hitl_token_here"
fly secrets set SYNC_HITL_ADVERTISER_TOKEN="your_sync_hitl_token_here"
```

**Step 2: Update Agent Configuration**
```bash
# Single line format for terminal
fly secrets set SALES_AGENTS_CONFIG='{"agents":[{"id":"sync_hitl_advertiser_a2a","name":"Automatic Approval - A2A (10s delay)","agent_uri":"https://test-agent.sales-agent.scope3.com","protocol":"a2a","auth_token_env":"SYNC_HITL_ADVERTISER_TOKEN","requiresAuth":true},{"id":"sync_hitl_advertiser_mcp","name":"Automatic Approval - MCP (10s delay)","agent_uri":"https://test-agent.sales-agent.scope3.com/mcp/","protocol":"mcp","auth_token_env":"SYNC_HITL_ADVERTISER_TOKEN","requiresAuth":true},{"id":"async_hitl_advertiser_a2a","name":"Async HITL Advertiser - A2A (125s timeout)","agent_uri":"https://test-agent.sales-agent.scope3.com","protocol":"a2a","auth_token_env":"ASYNC_HITL_ADVERTISER_TOKEN","requiresAuth":true},{"id":"async_hitl_advertiser_mcp","name":"Async HITL Advertiser - MCP (125s timeout)","agent_uri":"https://test-agent.sales-agent.scope3.com/mcp/","protocol":"mcp","auth_token_env":"ASYNC_HITL_ADVERTISER_TOKEN","requiresAuth":true}]}'
```

**Step 3: Enable Real Agents Mode**
```bash
fly secrets set USE_REAL_AGENTS=true
```

**Step 4: Deploy**
```bash
fly deploy
```

## 🧪 Local Testing Setup

**Create `.env.production` file:**
```bash
# Production HITL Test Tokens
ASYNC_HITL_ADVERTISER_TOKEN="your_async_hitl_token_here"
SYNC_HITL_ADVERTISER_TOKEN="your_sync_hitl_token_here"

# Agent Configuration
SALES_AGENTS_CONFIG='{"agents":[{"id":"sync_hitl_advertiser_a2a","name":"Automatic Approval - A2A (10s delay)","agent_uri":"https://test-agent.sales-agent.scope3.com","protocol":"a2a","auth_token_env":"SYNC_HITL_ADVERTISER_TOKEN","requiresAuth":true},{"id":"sync_hitl_advertiser_mcp","name":"Automatic Approval - MCP (10s delay)","agent_uri":"https://test-agent.sales-agent.scope3.com/mcp/","protocol":"mcp","auth_token_env":"SYNC_HITL_ADVERTISER_TOKEN","requiresAuth":true},{"id":"async_hitl_advertiser_a2a","name":"Async HITL Advertiser - A2A (125s timeout)","agent_uri":"https://test-agent.sales-agent.scope3.com","protocol":"a2a","auth_token_env":"ASYNC_HITL_ADVERTISER_TOKEN","requiresAuth":true},{"id":"async_hitl_advertiser_mcp","name":"Async HITL Advertiser - MCP (125s timeout)","agent_uri":"https://test-agent.sales-agent.scope3.com/mcp/","protocol":"mcp","auth_token_env":"ASYNC_HITL_ADVERTISER_TOKEN","requiresAuth":true}]}'

USE_REAL_AGENTS=true
```

**Test locally:**
```bash
# Load environment and start server
source .env.production && npm start
```

## 📊 Expected Behavior

### Agent Availability
- **4 total agents** available in UI dropdown
- **2 sync agents** (A2A + MCP) with ~10s delay  
- **2 async agents** (A2A + MCP) with ~125s timeout

### Protocol Comparison Testing
- **A2A variants**: Faster response times (~6ms average)
- **MCP variants**: More robust, reliable (~200ms average)
- **Sync vs Async**: Test different HITL simulation patterns

## 🔐 Security Notes

- ✅ **Tokens stored as environment variables** (not hardcoded)
- ✅ **GitGuardian compliant** (no secrets in code)
- ✅ **Production ready** (secure token management)
- ✅ **Environment isolation** (local vs production configs)

## 📈 Monitoring

After deployment, verify:
```bash
# Check agent loading
fly logs -n | grep "Configured agents"

# Should show: "📡 Configured agents: 4"
# Should list all 4 agents with correct protocols
```

---
*Generated with security-first practices - no hardcoded tokens* 🔒