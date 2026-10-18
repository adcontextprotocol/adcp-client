---
'@adcp/sdk': minor
---

Experimental AdCP 3.3 identity: align Web Bot Auth verification with what Cloudflare's `web-bot-auth` accepts. These changes affect the experimental `@adcp/sdk/identity-3.3` surface only; the RFC 9421 profile is unchanged.

- **Other signatures are not read.** `verifyWebBotAuth` selects the one `Signature-Input` member tagged `web-bot-auth` and ignores members with other tags, which WBA section 5.2.2 allows. A second `web-bot-auth` member or a second `Signature-Agent` member is still a 403.
