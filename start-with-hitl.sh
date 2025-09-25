#!/bin/bash

# Start the testing server with local HITL configuration

echo "🔧 Configuring local HITL agents..."

# Load environment variables for HITL tokens
if [ -f .env.hitl ]; then
  echo "📄 Loading HITL environment variables from .env.hitl..."
  export $(cat .env.hitl | xargs)
else
  echo "⚠️  Warning: .env.hitl file not found. Using environment variable defaults."
  echo "   Create .env.hitl with your HITL authentication tokens:"
  echo "   HITL_SYNC_TOKEN=your_sync_token"
  echo "   HITL_ASYNC_TOKEN=your_async_token"  
  echo "   WONDERSTRUCK_TOKEN=your_wonderstruck_token"
fi

export SALES_AGENTS_CONFIG='{
  "agents": [
    {
      "id": "sync_principal_mcp",
      "name": "HITL Sync Principal (MCP)",
      "agent_uri": "http://localhost:8176/mcp/",
      "protocol": "mcp",
      "auth_token_env": "HITL_SYNC_TOKEN",
      "requiresAuth": true
    },
    {
      "id": "async_principal_mcp", 
      "name": "HITL Async Principal (MCP)",
      "agent_uri": "http://localhost:8176/mcp/",
      "protocol": "mcp",
      "auth_token_env": "HITL_ASYNC_TOKEN",
      "requiresAuth": true
    },
    {
      "id": "principal_8ac9e391",
      "name": "Wonderstruck (MCP)",
      "agent_uri": "https://wonderstruck.sales-agent.scope3.com/mcp/",
      "protocol": "mcp",
      "auth_token_env": "WONDERSTRUCK_TOKEN",
      "requiresAuth": true
    }
  ]
}'

export USE_REAL_AGENTS=true

echo "📡 Starting AdCP Testing Framework with HITL agents..."
echo "   - HITL Sync Principal (MCP) - 10s delay"
echo "   - HITL Async Principal (MCP) - 125s delay + webhook"
echo "   - Wonderstruck (MCP) - production agent"
echo ""
echo "🌐 Server will be available at:"
echo "   http://localhost:3000 (development)"
echo "   http://localhost:8080 (production)"
echo ""

# Start the server
node dist/server/server.js