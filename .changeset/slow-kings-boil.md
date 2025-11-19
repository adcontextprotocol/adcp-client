---
'@adcp/client': minor
---

Fixed critical validation bug where sync_creatives, create_media_buy, build_creative, and get_products requests were not being validated. These request schemas now properly validate at runtime before sending to agents.

BREAKING CHANGE: Previously, malformed requests to these endpoints would bypass client-side validation and fail at the agent. Now, invalid requests are rejected immediately with clear error messages.

Additionally, request validation now uses strict mode to reject unknown top-level fields (e.g., typos like `mode` instead of `dry_run`), providing fail-fast behavior and consistency with the Python client.

Impact:
- Client-side validation catches errors before network requests
- Unknown top-level fields are now rejected (strict validation)
- Nested object validation continues to use default Zod behavior (strips unknown fields)
- Consistency with Python client validation behavior

Migration notes:
- Fix any typos in top-level request fields
- Ensure request payloads match the AdCP specification
- Type mismatches and missing required fields now caught earlier
