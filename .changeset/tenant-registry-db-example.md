---
"@adcp/sdk": patch
---

Add DB-driven multi-tenant registry worked example with CI tests for concurrent recheck and unregister semantics; fix stale `MULTI-TENANT.md` skill doc constructor API.

New exports in `examples/decisioning-platform-multi-tenant-db.ts`:
- `buildDbMultiTenantRegistry()` — seeds from a DB-shaped async loader; compatible with pg, Prisma, or any async source
- `adminRegisterTenant()` — register without restart
- `adminRecheckTenant()` — zero-traffic-gap JWKS recheck after key rotation
- `adminUpdateTenant()` — unregister + re-register for platform-config updates (brief 503 window documented)
- `adminUnregisterTenant()` — immediate tenant removal

`test/examples/decisioning-platform-multi-tenant-db.test.js` CI test covers: strict typecheck gate, startup seeding, concurrent-recheck deduplication, unregister null-return, re-register restore, and the update-gap contract.

`skills/build-decisioning-platform/advanced/MULTI-TENANT.md` corrected: the previous version showed a non-existent `resolveTenant`/`buildPlatform` callback constructor that never matched the real `createTenantRegistry` API; updated to show `register()` call pattern and health state table.
