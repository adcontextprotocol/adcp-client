---
'@adcp/sdk': major
---

feat(test-controller): promote `query_upstream_traffic` to first-class `CONTROLLER_SCENARIOS` member

AdCP 3.1.0-beta.2 added `query_upstream_traffic` to `ListScenariosSuccess['scenarios']` (spec PR adcp#3816 landed). The SDK previously carried it as an open-extension literal because the schema cache predated the spec PR.

**Changes:**
- `CONTROLLER_SCENARIOS.QUERY_UPSTREAM_TRAFFIC = 'query_upstream_traffic'` — added as a first-class constant.
- `SCENARIO_MAP` extended with the `queryUpstreamTraffic` → `QUERY_UPSTREAM_TRAFFIC` mapping; auto-advertised via `scenariosFromStore` (canonical typed path) rather than the open-extension `allScenariosFromStore` path.
- Removed the local `QUERY_UPSTREAM_TRAFFIC_SCENARIO` literal and the `as unknown as ComplyTestControllerResponse` cast — `UpstreamTrafficSuccess` is now in the generated `ComplyTestControllerResponse` union.
- Exhaustive-scenario test fixture extended with `queryUpstreamTraffic` so the `CONTROLLER_SCENARIOS / SCENARIO_MAP coverage` invariant holds.

**Adopter migration:** purely additive. Adopters who implement the `queryUpstreamTraffic` store method now get type-safe advertisement; existing code unchanged.

Part of the #1902 8.0-beta sweep (2/5 structural breaks closed).
