---
'@adcp/sdk': patch
---

The `testCapabilityDiscovery` protocol/tool cross-check now keys `comply_test_controller` under `compliance_testing`, the protocol the capabilities parser reports for the `compliance_testing` block (#3279). It used `compliance`, so every agent that correctly declared the block failed with "Tools suggest unreported protocols: compliance (has: [comply_test_controller])". A `compliance_testing` block without `comply_test_controller` is now reported as a declared protocol with no matching tools. The table's keys are now type-checked against `AdcpProtocol`.
