# Deployment Guide

## Production Deployment to Fly.io

### 1. Prerequisites

```bash
# Install Fly.io CLI
curl -L https://fly.io/install.sh | sh

# Login to Fly.io
fly auth login
```

### 2. Initialize Fly.io App

```bash
# Initialize the app (run this once)
fly launch --name adcp-testing --region iad
```

### 3. Set Production Configuration

Configure your sales agents (replace with your actual agent endpoints and tokens):

```bash
fly secrets set 'SALES_AGENTS_CONFIG={
  "agents": [
    {
      "id": "your_agent_a2a",
      "name": "Your A2A Agent",
      "agent_uri": "https://your-agent-endpoint.com",
      "protocol": "a2a", 
      "auth_token_env": "your-actual-auth-token-here",
      "requiresAuth": true
    },
    {
      "id": "your_agent_mcp",
      "name": "Your MCP Agent",
      "agent_uri": "https://your-agent-endpoint.com/mcp",
      "protocol": "mcp",
      "auth_token_env": "your-actual-auth-token-here", 
      "requiresAuth": true
    }
  ]
}'
```

### 4. Deploy the Application

```bash
# Build and deploy
fly deploy

# Monitor deployment
fly logs
```

### 5. Configure Custom Domain

```bash
# Add SSL certificate for custom domain
fly certs add testing.adcontextprotocol.org

# Check certificate status
fly certs show testing.adcontextprotocol.org
```

Then update your DNS to point `testing.adcontextprotocol.org` to your Fly.io app.

### 6. Verify Deployment

```bash
# Check app status
fly status

# View logs
fly logs

# Test health endpoint
curl https://adcp-testing.fly.dev/health

# Test agents endpoint  
curl https://adcp-testing.fly.dev/api/agents
```

## Local Development with Real Agents

To test with real agents locally (without deploying):

```bash
# Set environment variable to use real agents
export USE_REAL_AGENTS=true

# Set agents config with your actual tokens
export SALES_AGENTS_CONFIG='{
  "agents": [
    {
      "id": "your_agent_a2a",
      "name": "Your A2A Agent", 
      "agent_uri": "https://your-agent-endpoint.com",
      "protocol": "a2a",
      "auth_token_env": "your-actual-auth-token-here",
      "requiresAuth": true
    }
  ]
}'

# Start development server
npm run dev
```

## Monitoring and Management

```bash
# View application metrics
fly metrics

# Scale application (if needed)
fly scale count 2

# View machine status
fly machine list

# SSH into running machine (for debugging)
fly ssh console
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `SALES_AGENTS_CONFIG` | JSON configuration of sales agents (includes auth tokens) | Yes |
| `NODE_ENV` | Environment (development/production) | No |
| `USE_REAL_AGENTS` | Force real agent usage in development | No |
| `REQUEST_TIMEOUT` | Agent request timeout in ms | No |
| `MAX_CONCURRENT` | Max concurrent agent requests | No |

## Troubleshooting

### Check Configuration
```bash
fly secrets list
```

### View Real-time Logs
```bash
fly logs -f
```

### Test Individual Endpoints
```bash
# Test health
curl https://your-app.fly.dev/health

# Test agents list
curl https://your-app.fly.dev/api/agents

# Test with real agent
curl -X POST https://your-app.fly.dev/api/test \
  -H "Content-Type: application/json" \
  -d '{
    "agents": [{"id": "your_agent_a2a", "name": "Test", "agent_uri": "https://your-agent-endpoint.com", "protocol": "a2a", "requiresAuth": true, "auth_token_env": "your-actual-auth-token-here"}],
    "brief": "Test brief for premium display advertising",
    "tool_name": "get_products"
  }'
```