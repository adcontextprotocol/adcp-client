---
"@adcp/sdk": patch
---

docs(AdcpErrorInfo): warn sellers that message/details are grader-visible via ComplianceResult

`AdcpErrorInfo.message` and `AdcpErrorInfo.details` JSDoc now note that these
fields are forwarded into `ComplianceResult.failures[].adcp_error` and are
grader-visible beyond the request lifetime. Sellers should not embed bearer
tokens, account IDs, or internal paths in these fields. Fixes #1697.
