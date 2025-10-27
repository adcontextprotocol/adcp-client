---
"@adcp/client": patch
---

UI formatting and error logging improvements

- Fixed media buy packages to include format_ids array (was causing Pydantic validation errors)
- Added error-level logging for failed media buy operations (create, update, get_delivery)
- Fixed format objects display in products table (was showing [object Object])
- Added runtime schema validation infrastructure with Zod
- Added request validation to ADCPClient (fail fast on invalid requests)
- Added configurable validation modes (strict/non-strict) via environment variables
- Preserved trailing slashes in MCP endpoint discovery
- Improved error display in UI debug panel with proper formatting
- Added structured logger utility to replace console statements
- **BREAKING**: Aligned budget handling with AdCP spec - MediaBuy.budget (object) is now MediaBuy.total_budget (number)
- **BREAKING**: Removed budget field from CreateMediaBuyRequest (calculated from packages per spec)
