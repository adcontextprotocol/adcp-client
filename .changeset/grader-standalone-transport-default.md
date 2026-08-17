---
"@adcp/sdk": patch
---

Align `gradeRequestSigning`/`gradeOneVector` transport defaults to `'mcp'`, matching `resolveVectorTransport`'s storyboard default. Direct API callers against MCP agents no longer need to pass `transport: 'mcp'` explicitly (the raw REST replay 404s on MCP agents by construction). `bin/adcp-grade.js` help text and the transport-mismatch hint updated for the new default: the raw→mcp retry hint now fires only on explicit `--transport raw` runs.
