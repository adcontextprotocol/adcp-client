---
'@adcp/sdk': patch
---

Return correctable `ACCOUNT_REQUIRED` when an account-scoped server operation omits `account` and authentication cannot select one, including compact lifecycle mutations, async discovery, and task polling. Buyer retry policy re-discovers the account before retrying. Buyer-supplied unknown, unauthorized, or mismatched account references continue to return terminal `ACCOUNT_NOT_FOUND`.
