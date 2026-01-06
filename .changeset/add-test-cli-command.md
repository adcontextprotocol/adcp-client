---
"@adcp/client": minor
---

Add `test` subcommand to CLI for running agent test scenarios

New CLI command enables testing AdCP agents directly from the command line:

```bash
# List available test scenarios
npx @adcp/client test --list-scenarios

# Run discovery tests against the built-in test agent
npx @adcp/client test test

# Run a specific scenario
npx @adcp/client test test full_sales_flow

# Test your own agent
npx @adcp/client test https://my-agent.com discovery --auth $TOKEN

# JSON output for CI pipelines
npx @adcp/client test test discovery --json
```

Available scenarios include: health_check, discovery, create_media_buy, full_sales_flow,
error_handling, validation, pricing_edge_cases, and more.

The command exits with code 0 on success, 3 on test failure, making it suitable for CI pipelines.
