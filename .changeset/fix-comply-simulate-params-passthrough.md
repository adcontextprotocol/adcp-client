---
"@adcp/sdk": patch
---

fix(comply): pass extension params through simulate_delivery and simulate_budget_spend dispatchers

`comply_test_controller`'s `params` field is spec-canonical `additionalProperties: true`, but the `SIMULATE_DELIVERY` and `SIMULATE_BUDGET_SPEND` dispatcher cases in `handleTestControllerRequest` silently dropped all keys not in their fixed typed sets. Extension params like `vendor_metric_values` (used by the `vendor_metric_accountability` storyboard) never reached seller adapters.

Both cases now spread the full `params` object verbatim. `TestControllerStore.simulateDelivery` and `simulateBudgetSpend`, along with `SimulateDeliveryParams` and `SimulateBudgetSpendParams` in `createComplyController`, gain `[key: string]: unknown` index signatures so extension fields are accessible to adapter authors without casting.
