---
"@adcp/client": patch
---

Improved debug logging and error messages for MCP protocol errors

- CLI now displays debug logs, conversation history, and full metadata when --debug flag is used
- MCP error responses (`isError: true`) now extract and display the actual error message from `content[].text`
- Previously showed "Unknown error", now shows detailed error like "Error calling tool 'list_authorized_properties': name 'get_testing_context' is not defined"
- Makes troubleshooting agent-side errors much easier for developers
