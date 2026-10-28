---
'@adcp/sdk': minor
---

Add an experimental, opt-in `projectToolSchemas` server option and a `projectSchemaForCapabilities(schema, capabilities)` helper in `@adcp/sdk/schemas`. Both are prototypes for the proposed `x-adcp-applies-when` annotation (adcontextprotocol/adcp#8452). With the option on, MCP `tools/list` input and output schemas drop optional properties whose annotation doesn't match the server's own `get_adcp_capabilities` declaration. Undeclared capability lists keep everything. The option is off by default, and `tools/list` is unchanged when it's off. The bundled AdCP schemas don't carry the annotation yet.
