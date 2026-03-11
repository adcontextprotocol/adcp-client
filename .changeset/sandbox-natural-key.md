---
"@adcp/client": minor
---

Add sandbox support to AccountCapabilities and testing scenarios. Sellers declaring `account.sandbox: true` in capabilities are now parsed and exposed via `supportsSandbox()`. Test scenarios support `sandbox: true` option to use the natural key (brand + operator + sandbox) without provisioning. Audience sync scenario updated to use `AccountReference` instead of deprecated bare `account_id`.
