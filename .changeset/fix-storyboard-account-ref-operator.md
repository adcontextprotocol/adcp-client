---
"@adcp/sdk": patch
---

Fix storyboard runner sending spec-invalid AccountReference when seller omits operator in sync_accounts response. The natural-key arm of AccountReference requires both brand and operator; the extractor now falls back to brand.domain when operator is absent, and omits the account field entirely when brand is not present, letting request-builder.ts fall through to resolveAccount(options).
