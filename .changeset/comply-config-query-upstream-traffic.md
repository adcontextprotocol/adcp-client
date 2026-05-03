---
"@adcp/sdk": minor
---

Add `queryUpstreamTraffic` adapter to `ComplyControllerConfig` so adopters using the high-level `complyTest:` opts surface on `createAdcpServerFromPlatform` can wire `query_upstream_traffic` (spec PR adcontextprotocol/adcp#3816) without dropping to the lower-level `registerTestController` API.

```ts
complyTest: {
  queryUpstreamTraffic: (params, _ctx) => {
    const result = recorder.query({
      principal: RECORDER_PRINCIPAL,
      ...(params.since_timestamp !== undefined && { sinceTimestamp: params.since_timestamp }),
      ...(params.endpoint_pattern !== undefined && { endpointPattern: params.endpoint_pattern }),
      ...(params.limit !== undefined && { limit: params.limit }),
    });
    return toQueryUpstreamTrafficResponse(result);
  },
}
```

The adapter forwards through to the existing `TestControllerStore.queryUpstreamTraffic` slot — no wire-shape change, no scenario-projection change. `advertisedScenarios()` includes `'query_upstream_traffic'` when the adapter is set, so `list_scenarios` reports it.

`hello_signals_adapter_marketplace.ts` migrated to use this surface — drops the manual `registerTestController` call after `createAdcpServerFromPlatform`. Closes the Phase 3 follow-up that punted this migration as "non-mechanical because the recorder integration would need a comply-adapter shape upstream." It does now.

The framework gate inside `createAdcpServerFromPlatform` (Phase 2 of #1435) covers `comply_test_controller` end-to-end here too — admits on resolver-stamped `mode: 'sandbox' | 'mock'`, refuses live-mode dispatch.
