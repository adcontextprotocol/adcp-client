---
"@adcp/client": minor
---

Add OAuth discovery utilities for checking if MCP servers support OAuth authentication.

New exports:
- `discoverOAuthMetadata(agentUrl)` - Fetches OAuth Authorization Server Metadata from `/.well-known/oauth-authorization-server`
- `supportsOAuth(agentUrl)` - Simple boolean check if server supports OAuth
- `supportsDynamicRegistration(agentUrl)` - Check if server supports dynamic client registration
- `OAuthMetadata` type - RFC 8414 Authorization Server Metadata structure
- `DiscoveryOptions` type - Options for discovery requests (timeout, custom fetch)
