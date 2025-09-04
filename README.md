# AdCP Testing Framework

A simplified, robust testing framework for AdCP (Ad Context Protocol) that supports both MCP and A2A protocols. This application provides both a web UI and API endpoints for testing sales agents.

## Features

- 🌐 **Web UI**: Interactive testing interface for manual testing
- 🔌 **REST API**: Endpoints for automated testing and integration
- 🔄 **Protocol Support**: Both MCP and A2A protocols
- ☁️ **Cloud Ready**: Optimized for Fly.io deployment
- 🏃 **Local Development**: Easy local development setup
- 📊 **Test Results**: Detailed test results with export capabilities

## Quick Start

### Local Development

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment** (optional)
   ```bash
   cp .env.example .env
   # Edit .env to configure your sales agents
   ```

3. **Start development server**
   ```bash
   npm run dev
   ```

4. **Open browser**
   - UI: http://localhost:3000
   - API: http://localhost:3000/api

### Production Build

```bash
npm run build
npm start
```

## Configuration

Configure sales agents via the `SALES_AGENTS_CONFIG` environment variable:

```json
{
  "agents": [
    {
      "id": "my-mcp-agent",
      "name": "My MCP Sales Agent",
      "agent_uri": "https://api.example.com/mcp",
      "protocol": "mcp",
      "requiresAuth": true,
      "auth_token_env": "MY_AGENT_TOKEN"
    },
    {
      "id": "my-a2a-agent", 
      "name": "My A2A Sales Agent",
      "agent_uri": "https://coordinator.example.com",
      "protocol": "a2a",
      "requiresAuth": false
    }
  ]
}
```

## API Endpoints

### Test Multiple Agents
```http
POST /api/test
Content-Type: application/json

{
  "agents": [
    {"id": "agent1", "name": "Agent 1", "agent_uri": "...", "protocol": "mcp"}
  ],
  "brief": "Brand story and requirements",
  "promoted_offering": "Optional offering description",
  "tool_name": "get_products"
}
```

### List Available Agents
```http
GET /api/agents
```

### Test Single Agent
```http
POST /api/agent/:agentId/test
Content-Type: application/json

{
  "brief": "Brand story and requirements",
  "promoted_offering": "Optional offering description", 
  "tool_name": "get_products"
}
```

### Get Standard Formats
```http
GET /api/formats/standard
```

### Health Check
```http
GET /health
```

## Deployment to Fly.io

1. **Install Fly CLI**
   ```bash
   curl -L https://fly.io/install.sh | sh
   ```

2. **Initialize and deploy**
   ```bash
   fly launch
   fly deploy
   ```

3. **Set environment variables**
   ```bash
   fly secrets set SALES_AGENTS_CONFIG='{"agents":[...]}'
   ```

4. **Configure custom domain**
   ```bash
   fly certs add testing.adcontextprotocol.org
   ```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `NODE_ENV` | Environment | `development` |
| `SALES_AGENTS_CONFIG` | JSON config of sales agents | Demo agents |
| `REQUEST_TIMEOUT` | Request timeout in ms | `30000` |
| `MAX_CONCURRENT` | Max concurrent requests | `5` |
| `LOG_LEVEL` | Log level (debug, info, warn, error) | `info` |

## Project Structure

```
src/
├── server.ts          # Main Fastify server
├── protocols.ts       # MCP and A2A protocol handlers
├── types/
│   └── adcp.ts        # AdCP TypeScript definitions
└── public/
    └── index.html     # Web UI
```

## Development

- **Dev server**: `npm run dev` (auto-reload with tsx)
- **Build**: `npm run build` (TypeScript compilation)
- **Start**: `npm start` (run built JavaScript)
- **Generate types**: `npm run generate-types` (from AdCP schemas)

## License

MIT

---

Built for testing AdCP protocol compliance across MCP and A2A sales agents.