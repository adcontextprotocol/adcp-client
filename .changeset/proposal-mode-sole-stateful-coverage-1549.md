---
'@adcp/sdk': patch
---

test(examples): wire `comply_test_controller` into `examples/hello_seller_adapter_proposal_mode.ts` and add issue-#1549 invariant assertions to its gate test (#1549)

Test + worked-example change. The proposal-mode reference adapter now declares `compliance_testing.scenarios` and ships `complyTest` adapters (`seed.media_buy`, `force.media_buy_status`, `simulate.delivery`) for parity with the other reference seller adapters — relevant when downstream cascade scenarios in the broader `sales_proposal_mode` storyboard suite drive the controller. The companion gate test (`test/examples/hello-seller-adapter-proposal-mode.test.js`) adds invariant assertions specific to the SDK behavior PR #1545 introduced: sync_accounts skip carries the sole-stateful-step exemption marker, and downstream phases (`brief_with_proposals`, `refine_proposal`, `finalize_proposal`, `accept_proposal`) are not cascade-skipped from the setup-phase skip. Closes the example-tier coverage gap noted by `nodejs-testing-expert` on PR #1545. No library behavior change.
