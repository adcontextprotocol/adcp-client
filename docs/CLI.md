# AdCP CLI Tool

A simple command-line utility for calling AdCP agents directly without writing code.

## Installation

### Global Installation (Recommended for CLI usage)

```bash
npm install -g @adcp/client
```

After global installation, the `adcp` command will be available system-wide.

### Local Installation

```bash
npm install @adcp/client
```

Then use via npx:

```bash
npx adcp [arguments...]
```

## Quick Start

### List Available Tools

First, discover what tools/skills an agent supports:

```bash
adcp a2a https://test-agent.adcontextprotocol.org
adcp mcp https://agent.example.com/mcp
```

### Call a Tool

Once you know what's available, call a specific tool:

```bash
adcp mcp https://agent.example.com/mcp get_products '{"brief":"coffee brands"}'
```

## Usage

```
adcp <protocol> <agent-url> [tool-name] [payload] [options]
```

### Required Arguments

- **protocol**: Protocol to use (`mcp` or `a2a`)
- **agent-url**: Full URL to the agent endpoint

### Optional Arguments

- **tool-name**: Name of the AdCP tool/task to call (omit to list available tools)
- **payload**: JSON payload for the tool (default: `{}`)
  - Inline JSON: `'{"brief":"text"}'`
  - File path: `@payload.json`
  - Stdin: `-`

### Options

- `--auth TOKEN`: Authentication token for the agent
- `--help, -h`: Show help message
- `--json`: Output raw JSON response (default: pretty print)
- `--debug`: Show debug information

## Examples

### List Available Tools/Skills

Discover what an agent can do (no tool name = list tools):

```bash
# List MCP tools
adcp mcp https://agent.example.com/mcp

# List A2A skills
adcp a2a https://test-agent.adcontextprotocol.org
```

Example output:
```
📋 Available A2A Skills

Agent: AdCP Sales Agent
Description: AI agent for programmatic advertising campaigns via AdCP protocol

1. get_products
   Browse available advertising products and inventory

2. create_media_buy
   Create advertising campaigns with products, targeting, and budget

3. list_creative_formats
   List all available creative formats and specifications
...
```

### Basic Product Discovery (MCP)

```bash
adcp mcp https://agent.example.com/mcp get_products '{"brief":"coffee subscription service","promoted_offering":"Premium coffee deliveries"}'
```

### With Authentication (A2A)

```bash
adcp a2a https://agent.example.com list_creative_formats '{}' --auth your_token_here
```

### From File

Create a payload file:

```json
{
  "brief": "Eco-friendly products for millennials",
  "promoted_offering": "Sustainable consumer goods",
  "budget": 50000
}
```

Then call:

```bash
adcp mcp https://agent.example.com/mcp get_products @payload.json --auth $AGENT_TOKEN
```

### From Stdin

```bash
echo '{"brief":"travel packages"}' | adcp mcp https://agent.example.com/mcp get_products -
```

### Create Media Buy

```bash
adcp mcp https://agent.example.com/mcp create_media_buy '{
  "brief": "Summer campaign",
  "packages": [
    {
      "format_ids": [{"agent_url": "https://creative.example.com", "id": "banner_300x250"}],
      "impressions": 100000
    }
  ]
}' --auth $TOKEN
```

### With Debug Output

```bash
adcp mcp https://agent.example.com/mcp get_products '{"brief":"test"}' --debug
```

Output includes:
- Configuration details
- Request/response timing
- Full error stack traces

### JSON Output (for scripting)

```bash
# Get raw JSON for parsing
adcp mcp https://agent.example.com/mcp get_products '{"brief":"test"}' --json > output.json

# Use with jq
adcp mcp https://agent.example.com/mcp get_products '{"brief":"test"}' --json | jq '.products[0].name'
```

## Environment Variables

### ADCP_AUTH_TOKEN

Set a default authentication token:

```bash
export ADCP_AUTH_TOKEN="your_token_here"
adcp mcp https://agent.example.com/mcp get_products '{"brief":"test"}'
```

The `--auth` flag overrides this environment variable.

### ADCP_DEBUG

Enable debug mode by default:

```bash
export ADCP_DEBUG=true
adcp mcp https://agent.example.com/mcp get_products '{"brief":"test"}'
```

## Async/Webhook Support with ngrok

The CLI can automatically handle async agent responses using ngrok to create temporary webhook endpoints.

### Setup

First, install ngrok:

```bash
# Mac
brew install ngrok

# Windows
choco install ngrok

# Linux
# Download from https://ngrok.com/download
```

### Usage

#### With Remote Agents (ngrok)

Use the `--wait` flag to wait for async responses from remote agents:

```bash
adcp mcp https://agent.example.com/mcp create_media_buy @payload.json --auth $TOKEN --wait
```

**What happens:**
1. CLI starts a local webhook server
2. ngrok creates a public tunnel to your local server
3. CLI calls the agent with the ngrok webhook URL
4. If the agent returns `submitted` or `working` status, CLI waits for webhook
5. Agent sends response to webhook when ready
6. CLI displays the final response and cleans up

#### With Local Agents (no ngrok)

Use `--wait --local` for local development without ngrok:

```bash
adcp mcp http://localhost:3000/mcp create_media_buy @payload.json --wait --local
```

**Perfect for:**
- Testing with local agent servers
- Development without internet
- No ngrok account needed
- Faster setup (no tunnel creation)

**Example output:**
```
🌐 Webhook endpoint ready
   URL: https://abc123.ngrok.io
   Timeout: 300s

📤 Task submitted, waiting for async response...
⏳ Waiting for async response...
✅ Response received after 45.2s

✅ ASYNC RESPONSE RECEIVED

Response:
{
  "status": "approved",
  "media_buy_id": "mb_12345",
  ...
}
```

### Options

- `--wait`: Enable webhook waiting (requires ngrok or `--local`)
- `--local`: Use local webhook without ngrok (for local agents only)
- `--timeout MS`: Set webhook timeout in milliseconds (default: 300000 = 5 minutes)
- `--debug`: Show detailed webhook setup and progress

### Example: Async Media Buy Creation

**Remote agent with ngrok:**
```bash
# Create payload file
cat > media-buy.json <<EOF
{
  "brief": "Summer campaign",
  "packages": [{
    "format_ids": [{"agent_url": "...", "id": "banner_300x250"}],
    "impressions": 100000
  }]
}
EOF

# Submit and wait for approval
adcp mcp https://agent.example.com/mcp create_media_buy @media-buy.json \
  --auth $TOKEN \
  --wait \
  --timeout 600000
```

**Local agent without ngrok:**
```bash
# Start your local agent first
# cd my-agent && npm start

# Then submit request
adcp mcp http://localhost:3000/mcp create_media_buy @media-buy.json \
  --wait \
  --local \
  --timeout 600000
```

### Troubleshooting

**"ngrok not found":**
- Make sure ngrok is installed and in your PATH
- Run `which ngrok` to verify installation

**"Webhook timeout":**
- Agent took longer than timeout to respond
- Increase timeout with `--timeout 600000` (10 minutes)
- Check agent status independently

**ngrok connection issues:**
- Check your internet connection
- Free ngrok accounts have rate limits
- Consider upgrading to ngrok paid plan for production use

## Exit Codes

- `0`: Success
- `1`: General error (network issues, invalid JSON, etc.)
- `2`: Invalid arguments (wrong protocol, missing required args)
- `3`: Agent error (task failed, authentication failed, webhook timeout)

## Scripting with the CLI

### Bash Script Example

```bash
#!/bin/bash

AGENT_URL="https://agent.example.com/mcp"
AUTH_TOKEN="your_token"

# Discover products
products=$(adcp mcp "$AGENT_URL" get_products '{
  "brief": "Summer fashion campaign",
  "promoted_offering": "Sustainable clothing"
}' --auth "$AUTH_TOKEN" --json)

# Check if successful
if [ $? -eq 0 ]; then
  echo "Found products:"
  echo "$products" | jq '.products[] | .name'
else
  echo "Failed to get products"
  exit 1
fi
```

### Node.js Script Example

```javascript
import { execSync } from 'child_process';

try {
  const result = execSync(
    `adcp mcp https://agent.example.com/mcp get_products '{"brief":"test"}' --json`,
    { encoding: 'utf-8' }
  );

  const data = JSON.parse(result);
  console.log('Products:', data.products);
} catch (error) {
  console.error('CLI failed:', error.message);
}
```

## Available AdCP Tools/Tasks

Common AdCP tools you can call:

- `get_products` - Discover advertising products
- `list_creative_formats` - List available creative formats
- `create_media_buy` - Create a new media buy
- `update_media_buy` - Update an existing media buy
- `sync_creatives` - Sync creative assets
- `list_creatives` - List creative assets
- `get_media_buy_delivery` - Get delivery information
- `list_authorized_properties` - List authorized properties
- `provide_performance_feedback` - Provide campaign feedback
- `get_signals` - Get audience signals
- `activate_signal` - Activate audience signals

## Troubleshooting

### "Cannot find module" Error

Make sure the library is built:

```bash
npm run build:lib
```

### Authentication Failures

Check that:
1. Your token is valid and not expired
2. The agent URL is correct
3. The agent supports the protocol you specified

### Invalid JSON Payload

Ensure your JSON is properly escaped:

```bash
# Good - single quotes around JSON
adcp mcp https://agent.example.com/mcp get_products '{"brief":"test"}'

# Bad - unescaped quotes
adcp mcp https://agent.example.com/mcp get_products {"brief":"test"}
```

Or use a file:

```bash
adcp mcp https://agent.example.com/mcp get_products @payload.json
```

## Advanced Usage

### Piping Multiple Commands

```bash
# Discover products, extract first product ID, create media buy
product_id=$(adcp mcp https://agent.example.com/mcp get_products '{"brief":"test"}' --json | jq -r '.products[0].id')

adcp mcp https://agent.example.com/mcp create_media_buy "{
  \"product_id\": \"$product_id\",
  \"impressions\": 100000
}" --auth $TOKEN
```

### Error Handling in Scripts

```bash
if ! adcp mcp https://agent.example.com/mcp get_products '{"brief":"test"}' 2>/dev/null; then
  echo "First agent failed, trying backup..."
  adcp a2a https://backup-agent.example.com get_products '{"brief":"test"}'
fi
```

## Comparison with Library Usage

### CLI

```bash
adcp mcp https://agent.example.com/mcp get_products '{"brief":"coffee"}' --auth $TOKEN
```

### Library (TypeScript)

```typescript
import { ADCPClient } from '@adcp/client';

const client = new ADCPClient({
  id: 'agent',
  name: 'Agent',
  agent_uri: 'https://agent.example.com/mcp',
  protocol: 'mcp',
  auth_token_env: process.env.TOKEN
});

const result = await client.getProducts({
  brief: 'coffee'
});
```

The CLI is perfect for:
- Quick testing and exploration
- Shell scripts and automation
- CI/CD pipelines
- One-off API calls

The library is better for:
- Complex multi-agent workflows
- Conversation management
- Input handlers and clarifications
- Production applications

## Getting Help

- CLI Help: `adcp --help`
- Library Docs: https://github.com/adcontextprotocol/adcp-client
- Issues: https://github.com/adcontextprotocol/adcp-client/issues
- Email: maintainers@adcontextprotocol.org
