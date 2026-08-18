---
'@adcp/sdk': patch
---

Align `gradeRequestSigning`/`gradeOneVector` transport defaults to `'mcp'`, matching the storyboard runner behavior intended for the 13.0 release. Direct API callers against MCP agents no longer need to pass `transport: 'mcp'` explicitly (the raw REST replay 404s on MCP agents by construction). REST-binding callers must now pass `transport: 'raw'` or `--transport raw`. The MCP path now completes the official initialize lifecycle, carries the negotiated protocol version, and accurately skips URL-only vectors whose coverage cannot survive MCP reshaping.
