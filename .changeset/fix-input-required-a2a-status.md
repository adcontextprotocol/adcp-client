---
"@adcp/client": patch
---

Fixed ProtocolResponseParser to correctly detect input-required status in A2A JSON-RPC wrapped responses. The parser now checks response.result.status.state for A2A responses before falling back to other status locations, preventing "Schema validation failed" errors when agents return input-required status.
