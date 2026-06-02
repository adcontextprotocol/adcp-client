---
'@adcp/sdk': major
---

Remove generated Zod schema exports and tool schema maps from the root package
and `@adcp/sdk/types`. Import runtime schemas, `TOOL_REQUEST_SCHEMAS`, and
`TOOL_RESPONSE_SCHEMAS` from `@adcp/sdk/schemas` instead. This keeps ordinary
SDK imports from forcing the large generated schema declaration bundle into
TypeScript programs.
