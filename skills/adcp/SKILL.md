---
name: adcp
description: Interact with AdCP (Ad Context Protocol) advertising agents over MCP or A2A protocols. Use when the user wants to call AdCP tools (get_products, create_media_buy, sync_creatives, etc.), discover an agent's capabilities, run protocol compliance tests, look up brands or properties in the AdCP registry, manage saved agent aliases, or debug agent responses. NOT for general HTTP/REST API calls. Requires @adcp/client (npm).
argument-hint: "<agent> [tool] [payload] | test <agent> [scenario] | registry <command>"
allowed-tools: Bash, Read
---

# AdCP CLI

Use `adcp` (or `npx @adcp/client`) to interact with AdCP advertising agents, run compliance tests, and query the AdCP registry.

## Quick start — zero config

Built-in test agents work immediately with no setup:

```bash
# Try AdCP right now
adcp test-mcp                                          # List tools on the MCP test agent
adcp test-mcp get_products '{"brief":"coffee brands"}' # Call a tool
adcp test-a2a get_products '{"brief":"coffee brands"}' # Same thing over A2A

# Run compliance tests
adcp test test-mcp discovery                           # Test tool discovery
adcp test test-mcp full_sales_flow                     # Full media buy lifecycle
```

Built-in aliases (no setup needed):
- `test-mcp` — Public test agent via MCP (pre-authenticated)
- `test-a2a` — Public test agent via A2A (pre-authenticated)
- `test-no-auth` — MCP without auth (demonstrates auth errors)
- `test-a2a-no-auth` — A2A without auth
- `creative` — Official creative agent (MCP, requires `--auth` or `ADCP_AUTH_TOKEN`)

## Calling agent tools

```bash
adcp <alias|url> [tool-name] [payload] [options]
```

### Discover tools (omit tool name)
```bash
adcp https://agent.example.com
adcp my-alias
```

### Call a tool
```bash
adcp https://agent.example.com get_products '{"brief":"coffee brands"}'
adcp https://agent.example.com create_media_buy @payload.json
echo '{"brief":"travel"}' | adcp https://agent.example.com get_products -
```

### Authentication (priority order)
```bash
adcp my-alias get_products '{}'                                         # 1. Saved config
adcp https://agent.example.com get_products '{}' --auth $TOKEN          # 2. Flag
export ADCP_AUTH_TOKEN=your-token && adcp https://agent.example.com get_products '{}' # 3. Env
adcp https://agent.example.com/mcp --oauth                              # 4. OAuth (MCP only)
```

### Output modes
```bash
adcp test-mcp get_products '{"brief":"test"}'          # Pretty print (default)
adcp test-mcp get_products '{"brief":"test"}' --json   # Raw JSON for scripting
adcp test-mcp get_products '{"brief":"test"}' --debug  # Connection diagnostics
```

### Force protocol (default is auto-detect)
```bash
adcp https://agent.example.com get_products '{}' --protocol mcp
adcp https://agent.example.com get_products '{}' --protocol a2a
```

## Test runner

Run protocol compliance tests against any AdCP agent. 19 built-in scenarios.

```bash
adcp test <agent> [scenario] [options]
adcp test --list-scenarios
```

### Scenarios (run `adcp test --list-scenarios` for all 19 with descriptions)
| Scenario | What it tests |
|----------|---------------|
| `health_check` | Basic connectivity |
| `discovery` | get_products, list_creative_formats, list_authorized_properties |
| `create_media_buy` | Discovery + create a media buy (dry-run by default) |
| `full_sales_flow` | Full lifecycle: discovery, create, update, delivery |
| `creative_flow` | Creative agent: list_formats, build, preview |
| `signals_flow` | Signals: get_signals, activate |
| `validation` | Schema validation (invalid inputs should be rejected) |
| `error_handling` | Verify proper error responses |
| `pricing_edge_cases` | Auction vs fixed pricing, min spend, bid_price |
| `behavior_analysis` | Auth, brief relevance, filtering behavior |
| `capability_discovery` | v3: get_adcp_capabilities |
| `governance_property_lists` | v3: property list CRUD |
| `governance_content_standards` | v3: content standards listing and calibration |
| `si_session_lifecycle` | v3: structured interaction sessions |

### Examples
```bash
adcp test test-mcp discovery                           # Quick check
adcp test test-mcp full_sales_flow --json              # CI-friendly JSON output
adcp test https://my-agent.com validation --protocol mcp
adcp test my-alias create_media_buy --no-dry-run       # Real operations (careful!)
```

### Test options
- `--json` — Machine-readable output for CI
- `--debug` — Verbose logging
- `--protocol mcp|a2a` — Force protocol
- `--no-dry-run` — Execute real operations (default is dry-run)
- `--brief "text"` — Custom brief for product discovery tests

## Registry

Look up brands, properties, agents, and publishers in the AdCP registry.

```bash
adcp registry <command> [args] [options]
```

### Lookups
```bash
adcp registry brand nike.com
adcp registry brands nike.com adidas.com --json
adcp registry property nytimes.com
adcp registry enrich-brand nike.com
```

### Discovery and validation
```bash
adcp registry discover https://agent.example.com
adcp registry validate nytimes.com
adcp registry validate-publisher nytimes.com
adcp registry lookup nytimes.com
adcp registry check-auth https://agent.com domain nytimes.com
```

### Listing and search
```bash
adcp registry agents --type sales --health
adcp registry search nike --json
adcp registry publishers
adcp registry stats
```

### Save operations (requires --auth or ADCP_REGISTRY_API_KEY)
```bash
adcp registry save-brand acme.com "Acme Corp" --auth $KEY
adcp registry save-property example.com https://agent.com --auth $KEY
```

## Agent management

```bash
adcp --save-auth prod https://prod-agent.com           # Interactive setup
adcp --save-auth prod https://agent.com --auth $TOKEN  # With token
adcp --save-auth prod https://agent.com --no-auth      # No auth
adcp --save-auth prod https://agent.com/mcp --oauth    # OAuth (MCP only)
adcp --list-agents
adcp --remove-agent prod
adcp --show-config
```

Config stored at `~/.adcp/config.json`.

## Async/webhook support

For long-running operations (e.g. create_media_buy with human-in-the-loop approval):

```bash
adcp https://agent.example.com create_media_buy @payload.json --auth $TOKEN --wait
adcp http://localhost:3000/mcp create_media_buy @payload.json --wait --local
```

- `--wait` — Start webhook listener, wait for async response
- `--local` — Local webhook without ngrok (for localhost agents)
- `--timeout MS` — Webhook timeout (default: 300000 = 5 min)

Remote `--wait` requires ngrok: `brew install ngrok`

## Exit codes

- `0` — Success
- `1` — Network or JSON error
- `2` — Invalid arguments
- `3` — Agent error (auth failure, task failed, webhook timeout)

## Task: $ARGUMENTS

### Step 1: Check installation
```bash
which adcp 2>/dev/null && echo "installed" || echo "use npx @adcp/client"
```
If not installed, prefix all commands with `npx @adcp/client`. Requires Node.js 18+.

### Step 2: Route the request

- **"try AdCP" / "show me how it works" / no specific agent** — Use built-in `test-mcp`
- **"what tools" / "discover" / "list tools"** — `adcp <agent>` with no tool name
- **"test" / "run tests" / "compliance" / "validate agent"** — `adcp test <agent> [scenario]`
- **"brand" / "property" / "registry" / "look up" / "validate domain"** — `adcp registry <command>`
- **Specific tool name mentioned** — `adcp <agent> <tool> '<payload>'`
- **"compare protocols"** — Run same call with `--protocol mcp` then `--protocol a2a`, diff results

### Step 3: Handle authentication

1. Built-in aliases `test-mcp` and `test-a2a` have auth included — use for demos
2. `creative` alias has no auth bundled — user must provide `--auth` or `ADCP_AUTH_TOKEN`
3. Saved aliases may have auth — check with `adcp --list-agents`
4. `--auth $TOKEN` flag or `ADCP_AUTH_TOKEN` env var
5. `--oauth` for MCP agents using OAuth (opens browser, saves tokens to alias)
6. If no auth and agent requires it, ask the user

### Step 4: Choose output format

- Default (pretty print) for exploration and debugging
- `--json` when piping, parsing, or running in CI
- `--debug` when troubleshooting connection or protocol issues

### Step 5: Run and interpret

- Run the command
- Exit code 1: network/parsing error — suggest `--debug`
- Exit code 2: bad arguments — check syntax
- Exit code 3: agent error — check auth token, try `--debug`, verify agent is reachable
- Empty results are valid — do not fabricate data
- For `--json` output, parse and summarize the key fields for the user
