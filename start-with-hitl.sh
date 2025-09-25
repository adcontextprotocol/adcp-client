#!/bin/bash

# Start the testing server with local HITL configuration

echo "🔧 Configuring local HITL agents..."

export SALES_AGENTS_CONFIG='{
  "agents": [
    {
      "id": "sync_principal_mcp",
      "name": "HITL Sync Principal (MCP)",
      "agent_uri": "http://localhost:8176/mcp/",
      "protocol": "mcp",
      "auth_token_env": "sync_token_2ea279d8f52c4739bb775323c0e6a38a",
      "requiresAuth": true
    },
    {
      "id": "async_principal_mcp", 
      "name": "HITL Async Principal (MCP)",
      "agent_uri": "http://localhost:8176/mcp/",
      "protocol": "mcp",
      "auth_token_env": "async_token_058870a84fe442a392f176f64f05c475",
      "requiresAuth": true
    },
    {
      "id": "principal_8ac9e391",
      "name": "Wonderstruck (MCP)",
      "agent_uri": "https://wonderstruck.sales-agent.scope3.com/mcp/",
      "protocol": "mcp",
      "auth_token_env": "UhwoigyVKdd6GT8hS04cc51ckGfi8qXpZL6OvS2i2cU",
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