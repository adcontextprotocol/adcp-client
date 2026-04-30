---
"@adcp/sdk": patch
---

fix(client): caller-supplied adcp_major_version wins over SDK envelope

ProtocolClient.callTool was spreading the SDK version envelope after caller args since 5.24, silently overwriting any adcp_major_version the caller supplied. Flips the spread order at all four sites (in-process MCP, HTTP MCP, createMCPClient, createA2AClient) so caller args win. This restores the 5.23 behavior and unblocks the unsupported_major_version storyboard step in error-compliance.yaml.
