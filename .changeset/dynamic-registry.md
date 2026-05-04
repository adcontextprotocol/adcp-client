---
'@adcp/sdk': minor
---

Add `createDynamicRegistry<TRegistries>` — multi-registry plumbing with atomic-bundle-swap, in-flight refresh coalescing, and pinned-carry-forward semantics. Packages the multi-registry-atomicity idiom every adopter that hot-reloads tenants from a database independently rebuilds (the shim in scope3data/agentic-adapters built this three times before the pattern crystallized).

Five lessons baked in: single-pointer atomic swap (concurrent readers see consistent snapshots across `await`), in-flight refresh coalescing (parallel `refresh()` calls share one Promise), pinned-carry-forward (entries with `{ pinned: true }` survive every refresh; pin always wins over `pending` writes), lock-step unregister (clears across all registries), per-registry typed `get`.

Two design refinements over the original issue: `pinned: true` flag at register time replaces the parallel `staticIds()` Set (single source of truth, no drift hazard); duplicate registration throws by default (`{ overwrite: true }` opt-in) so silent tenant clobbering doesn't ship to production. See #1531.
