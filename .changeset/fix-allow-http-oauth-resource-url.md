---
"@adcp/sdk": patch
---

Fixed `--allow-http` not propagating to `MCPOAuthProvider.validateResourceURL`. Local dev MCP servers on `http://localhost` now work with `--oauth` without requiring `ngrok` or `--allow-http`: loopback hosts (`localhost`, `127.0.0.1`, `[::1]`) are always allowed in resource URL validation, matching the existing `ClientCredentialsFlow` loopback carve-out. Non-loopback HTTP resource URLs are gated on the `--allow-http` flag, which is now correctly threaded from all five CLI OAuth call sites through `createCLIOAuthProvider` to the provider. Also adds `--allow-http` to the top-level `--help` OPTIONS output.
