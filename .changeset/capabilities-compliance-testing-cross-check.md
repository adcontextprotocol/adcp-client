---
'@adcp/sdk': patch
---

The `testCapabilityDiscovery` protocol/tool cross-check now keys `comply_test_controller` under `compliance_testing`, the protocol the capabilities parser reports for the `compliance_testing` block (#3279). It used `compliance`, so every agent that correctly declared the block failed with "Tools suggest unreported protocols: compliance (has: [comply_test_controller])". An agent that declares a `compliance_testing` block but does not expose `comply_test_controller` now fails the cross-check ("Protocol 'compliance_testing' reported but no matching tools found"), since the block declares the controller. The table's keys are now type-checked against `AdcpProtocol`.
