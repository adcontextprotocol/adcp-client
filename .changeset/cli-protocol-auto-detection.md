---
"@adcp/client": patch
---

Add protocol auto-detection to CLI tool

The CLI now automatically detects whether an agent uses A2A or MCP protocol when the protocol argument is omitted:

```bash
# Auto-detect protocol (tries A2A first, then MCP)
adcp https://test-agent.adcontextprotocol.org

# Explicit protocol as positional argument
adcp a2a https://test-agent.adcontextprotocol.org

# Explicit protocol as flag (skips auto-detection)
adcp --protocol mcp https://agent.example.com
```

Detection algorithm:
- Tests A2A by checking for agent card at `/.well-known/agent-card.json`
- Tests MCP at provided URL and with `/mcp` suffix
- Shows detected protocol with visual feedback

New `--protocol` flag allows explicit protocol specification, useful when:
- You want to skip auto-detection for speed
- Auto-detection fails due to network issues
- You're combining with other flags like `--auth`

This makes the CLI more user-friendly for exploratory testing and works with any AdCP-compliant agent.
