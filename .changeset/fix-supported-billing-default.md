---
"@adcp/sdk": patch
---

fix(server): default account.supported_billing to [] in createAdcpServerFromPlatform

The v6 platform path was conditionally omitting `account.supported_billing` from
`get_adcp_capabilities` responses when `supportedBillings` was not set or was empty.
The schema requires the field whenever the account block is present, causing schema
validation failures that cascaded into the storyboard runner treating v6 agents as v2.
Now always projects the account block with `supported_billing: []` as the default,
matching the v5 `createAdcpServer` behavior. Also fixes the JSDoc on
`DecisioningCapabilities.supportedBillings` which incorrectly claimed the default
was `['agent']`.
