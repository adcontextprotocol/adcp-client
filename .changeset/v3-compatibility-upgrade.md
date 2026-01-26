---
"@adcp/client": minor
---

Add ADCP v3.0 compatibility while preserving v2.5/v2.6 backward compatibility

**New Features:**
- Capability detection via `get_adcp_capabilities` tool or synthetic detection from tool list
- v3 request/response adaptation for pricing fields (fixed_price, floor_price)
- Authoritative location redirect handling with loop detection and HTTPS validation
- Server-side adapter interfaces (ContentStandardsAdapter, PropertyListAdapter, ProposalManager, SISessionManager)
- New domains: governance, sponsored-intelligence, protocol

**Adapters:**
- Pricing adapter: normalizes v2 (rate, is_fixed) to v3 (fixed_price, floor_price)
- Creative adapter: handles v2/v3 creative assignment field differences
- Format renders adapter: normalizes format render structures
- Preview normalizer: handles v2/v3 preview response differences

**Breaking Change Handling:**
- All v2 responses automatically normalized to v3 API
- Clients always see v3 field names regardless of server version
- v2 servers receive adapted requests with v2 field names
