---
'@adcp/sdk': minor
---

Handle AdCP 3.2 filters.property_list together with mixed app/CTV property-list enforcement. Resolve publisher selectors against supplied catalogs, preserve unknown-selector behavior and diagnostics, and fail closed on conflicting references.

Export identifier normalizers and typed publisher-domain validation. Add count/byte-bounded registry bulk resolution, rate-limit retries, per-input outcomes, and a larger default resolve response limit.

Publisher registrations must now supply canonical lowercase hostnames; normalize identifiers explicitly before calling saveProperty when migrating callers that previously submitted URLs, uppercase names, or surrounding whitespace.

Add an authenticated MCP property-list registration helper, signed list-change notifications using the existing webhook delivery kernel, and buyer-issued reference certification. Document contribution, serving, and migration choices.
