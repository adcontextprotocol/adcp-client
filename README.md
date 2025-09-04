# AdCP Testing Framework

A comprehensive testing framework for **AdCP (Ad Context Protocol)** that enables testing of advertising sales agents using both **MCP (Model Context Protocol)** and **A2A (Agent-to-Agent)** protocols. 

This tool helps developers and advertisers validate their sales agents' compliance with AdCP standards, test agent responses to different scenarios, and ensure proper protocol implementation.

## What is this?

AdCP is a protocol for advertising agents to communicate contextual information. This testing framework allows you to:

- **Test sales agents** that implement AdCP over MCP or A2A protocols
- **Validate responses** to brand briefs and product queries  
- **Compare agent performance** across different protocols
- **Debug protocol implementations** with detailed logging
- **Export test results** for analysis and reporting

## Features

- 🌐 **Interactive Web UI**: Point-and-click testing interface
- 🔌 **REST API**: Programmatic testing for CI/CD integration  
- 🔄 **Dual Protocol Support**: Test both MCP and A2A implementations
- ☁️ **Cloud Deployment**: Ready for Fly.io, Vercel, or any Node.js host
- 🏃 **Local Development**: Quick setup for development and testing
- 📊 **Detailed Results**: JSON export, timing data, error handling
- 🔐 **Authentication Support**: Bearer token auth for production agents
- 🐛 **Debug Mode**: Detailed request/response logging

## Quick Start (5 minutes)

### 1. Clone and Install
```bash
git clone <repository>
cd adcp-testing-framework
npm install
```

### 2. Start with Demo Agents
```bash
npm run dev
```

Open http://localhost:3000 - you'll see the testing interface with demo agents already configured.

### 3. Run Your First Test
1. Click **"Run Test"** with the default settings
2. Watch the test execute in real-time
3. View results in the **Test Results** section
4. Try different brand briefs and product queries

### 4. Configure Your Own Agents
Click **"Add Custom Agent"** and enter:
- **Name**: Your agent's display name
- **URI**: Your agent's endpoint URL
- **Protocol**: `mcp` or `a2a`
- **Auth Token**: Bearer token (if required)

**That's it!** You're now testing AdCP agents.

## Detailed Setup

### Local Development with Custom Agents

1. **Environment Configuration**
   ```bash
   cp .env.example .env
   ```

2. **Edit `.env` with your agents**
   ```bash
   # Example configuration
   SALES_AGENTS_CONFIG='{
     "agents": [
       {
         "id": "my_mcp_agent",
         "name": "My MCP Sales Agent", 
         "agent_uri": "https://api.mycompany.com/mcp",
         "protocol": "mcp",
         "requiresAuth": true,
         "auth_token_env": "MY_AGENT_TOKEN_HERE"
       },
       {
         "id": "my_a2a_agent",
         "name": "My A2A Sales Agent",
         "agent_uri": "https://coordinator.mycompany.com",
         "protocol": "a2a", 
         "requiresAuth": false
       }
     ]
   }'
   
   # If using auth tokens, set them as env vars or direct values
   MY_AGENT_TOKEN_HERE=your_actual_token_here
   ```

3. **Start development server**
   ```bash
   npm run dev
   ```

### Production Build

```bash
npm run build
npm start
```

The server runs on port 8080 in production, 3000 in development.

## Configuration

### Agent Configuration Formats

Agents are configured via the `SALES_AGENTS_CONFIG` environment variable. Here are examples for different scenarios:

#### Basic Agent (No Auth)
```json
{
  "agents": [
    {
      "id": "demo_agent",
      "name": "Demo Sales Agent",
      "agent_uri": "https://api.example.com/mcp", 
      "protocol": "mcp",
      "requiresAuth": false
    }
  ]
}
```

#### Agent with Authentication
```json
{
  "agents": [
    {
      "id": "prod_agent",
      "name": "Production Sales Agent",
      "agent_uri": "https://api.mycompany.com/mcp",
      "protocol": "mcp", 
      "requiresAuth": true,
      "auth_token_env": "YOUR_AUTH_TOKEN_HERE"
    }
  ]
}
```

#### Multiple Agents (MCP + A2A)
```json
{
  "agents": [
    {
      "id": "mcp_agent",
      "name": "MCP Sales Agent",
      "agent_uri": "https://api.example.com/mcp",
      "protocol": "mcp",
      "requiresAuth": true,
      "auth_token_env": "your_mcp_token"
    },
    {
      "id": "a2a_agent",
      "name": "A2A Sales Agent", 
      "agent_uri": "https://coordinator.example.com",
      "protocol": "a2a",
      "requiresAuth": true,
      "auth_token_env": "your_a2a_token"
    }
  ]
}
```

### Authentication Options

**Option 1: Direct Token** (50+ characters)
```bash
"auth_token_env": "your_long_bearer_token_here_must_be_50plus_chars"
```

**Option 2: Environment Variable Reference**
```bash
"auth_token_env": "MY_AGENT_TOKEN"
```
Then set: `export MY_AGENT_TOKEN=your_actual_token`

## Usage Examples

### Web UI Testing

1. **Open the interface**: http://localhost:3000
2. **Select agent(s)** from the dropdown
3. **Enter brand brief**: "Eco-friendly outdoor gear company targeting millennials"
4. **Set promoted offering**: "Sustainable hiking boots"  
5. **Choose tool**: `get_products` (most common)
6. **Click "Run Test"** and watch real-time results

### API Testing with curl

**Test single agent:**
```bash
curl -X POST http://localhost:3000/api/agent/my_mcp_agent/test \
  -H "Content-Type: application/json" \
  -d '{
    "brief": "Premium coffee roaster focusing on fair trade beans",
    "promoted_offering": "Single-origin Ethiopian coffee",
    "tool_name": "get_products"
  }'
```

**Test multiple agents:**
```bash
curl -X POST http://localhost:3000/api/test \
  -H "Content-Type: application/json" \
  -d '{
    "agents": [
      {"id": "agent1", "name": "Agent 1", "agent_uri": "https://api1.com/mcp", "protocol": "mcp"}
    ],
    "brief": "Tech startup selling productivity software",
    "tool_name": "get_products"
  }'
```

### Common Test Scenarios

**E-commerce Product Discovery:**
- Brief: "Fashion retailer targeting Gen Z with sustainable clothing"
- Offering: "Recycled polyester jackets"
- Tool: `get_products`

**B2B Lead Generation:**  
- Brief: "SaaS company providing CRM solutions for small businesses"
- Offering: "Affordable CRM with automation features"
- Tool: `get_products` or `generate_leads`

**Local Business Promotion:**
- Brief: "Family restaurant specializing in authentic Italian cuisine"
- Offering: "Weekend dinner specials"
- Tool: `get_products`

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

## Deployment

### Production (Fly.io)

The production environment is automatically deployed to Fly.io when commits are pushed to the `main` branch. 

- **Production URL**: https://adcp-testing.fly.dev
- **Auto-deployment**: Commits to `main` trigger automatic deployment
- **Configuration**: Production agents and secrets are managed separately

### Local Development Deployment

For testing your own deployment:

**Docker:**
```bash
docker build -t adcp-testing .
docker run -p 8080:8080 -e SALES_AGENTS_CONFIG='{"agents":[...]}' adcp-testing
```

**Other Platforms:**
- **Vercel**: `npx vercel --prod` 
- **Railway**: `railway up`
- **Heroku**: `git push heroku main`

Set `SALES_AGENTS_CONFIG` environment variable in your platform's dashboard.

## Troubleshooting

### Common Issues

**❌ "No agents configured"**
- Check `SALES_AGENTS_CONFIG` environment variable is set
- Verify JSON syntax is valid (use a JSON validator)
- Restart the server after changing environment variables

**❌ "Agent connection failed"**  
- Verify `agent_uri` is accessible (try in browser/Postman)
- Check authentication token is correct and not expired
- Ensure protocol (`mcp` or `a2a`) matches your agent's implementation
- Check network connectivity and firewall rules

**❌ "Authentication failed"**
- Verify `auth_token_env` contains valid bearer token
- Check token has proper permissions for your agent
- Ensure `requiresAuth: true` is set for authenticated agents
- Test token manually with curl: `curl -H "Authorization: Bearer YOUR_TOKEN" YOUR_AGENT_URI`

**❌ "Protocol errors"**
- MCP agents should respond to `/mcp` endpoints
- A2A agents should implement coordinator protocol
- Check agent logs for protocol-specific error messages
- Verify agent implements required AdCP methods

**❌ Port already in use**
```bash
# Kill process using port 3000
lsof -ti:3000 | xargs kill -9

# Or use different port
PORT=3001 npm run dev
```

### Debug Mode

Enable detailed logging:
```bash
LOG_LEVEL=debug npm run dev
```

This shows:
- Full HTTP request/response bodies
- Authentication token validation
- Protocol-specific message parsing  
- Timing information for each step

### Testing Agent Connectivity

**Test agent health:**
```bash
# For MCP agents
curl -X POST https://your-agent.com/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'

# For A2A agents  
curl -X GET https://your-coordinator.com/health \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Validate JSON configuration:**
```bash
echo '$SALES_AGENTS_CONFIG' | jq .
```

### Performance Issues

**Slow responses:**
- Check `REQUEST_TIMEOUT` setting (default 30s)
- Verify agent server performance
- Consider reducing `MAX_CONCURRENT` requests

**Memory usage:**
- Monitor with `npm run dev` vs `npm run build && npm start`
- Check for memory leaks in long-running tests

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

### Available Scripts

```bash
npm run dev              # Development server with auto-reload
npm run build            # Production build (TypeScript → JavaScript)
npm start                # Run production build
npm run generate-types   # Generate TypeScript types from AdCP schemas
npm run test            # Run test suite (if available)
```

### Project Structure
```
src/
├── server.ts              # Main Fastify server setup
├── protocols.ts           # MCP and A2A protocol handlers  
├── types/
│   ├── adcp.ts           # AdCP TypeScript definitions
│   └── adcp.generated.ts # Auto-generated from schemas
├── public/
│   ├── index.html        # Main web UI
│   └── sales-agents.html # Agent management UI
└── sales-agents-handlers-node.js # Node.js request handlers

scripts/
├── deploy.sh            # Deployment helper script
└── generate-types.ts    # Type generation script

fly.toml                 # Fly.io deployment configuration
Dockerfile              # Container configuration
package.json            # Dependencies and scripts
```

### Adding New Features

1. **New Protocol Support**: Extend `src/protocols.ts`
2. **UI Enhancements**: Modify `src/public/index.html`  
3. **API Endpoints**: Add routes in `src/server.ts`
4. **Type Definitions**: Update `src/types/adcp.ts`

### Testing Your Changes

```bash
# Test locally with demo agents
npm run dev

# Test with your production agents
SALES_AGENTS_CONFIG='{"agents":[...]}' npm run dev

# Test API endpoints
curl -X POST http://localhost:3000/api/test -H "Content-Type: application/json" -d '{...}'
```

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature-name`
3. Make changes and test locally
4. Ensure TypeScript compiles: `npm run build`
5. Submit a pull request

### Reporting Issues

Include in your issue:
- Node.js version (`node --version`)
- Error messages and stack traces
- Agent configuration (remove sensitive tokens)
- Steps to reproduce

## FAQ

**Q: Can I test agents locally during development?**  
A: Yes! Set up a local MCP server or use the demo agents included.

**Q: What's the difference between MCP and A2A protocols?**  
A: MCP uses JSON-RPC over HTTP, A2A uses REST APIs. Both implement AdCP for advertising use cases.

**Q: How do I know if my agent is AdCP compliant?**  
A: Run tests with standard brand briefs and check that responses include required fields and proper formatting.

**Q: Can I use this for production agent monitoring?**  
A: Yes! Deploy to Fly.io and set up scheduled tests via cron or monitoring services.

**Q: How do I add custom test scenarios?**  
A: Use the web UI to enter different brand briefs and promoted offerings, or call the API with custom data.

## License

MIT License - feel free to use this for testing your own AdCP implementations.

---

**Built for testing AdCP protocol compliance across MCP and A2A sales agents.**

🔗 **Resources:**
- [AdCP Specification](https://adcontextprotocol.org) 
- [MCP Protocol](https://modelcontextprotocol.io)
- [Fly.io Docs](https://fly.io/docs)

For questions or support, please [open an issue](https://github.com/your-org/adcp-testing-framework/issues).