---
'@adcp/sdk': patch
---

Experimental AdCP 3.3 Web Bot Auth fixes (follow-up to #3244): replay caches keep a nonce through the inclusive end of the acceptance window (WBA, RFC 9421 request and webhook verifiers), so a signature cannot be replayed at exactly `expires` plus skew; directory, signing-fetch (WBA and RFC 9421) and WBA webhook-receiver bodies keep a UTF-8 BOM so digests cover the exact bytes; signed directories backdate `created` by 60 seconds and verifiers tolerate that skew; a `web-bot-auth` request missing `Signature-Agent`, `Signature-Input`, `Signature` or its `Signature-Agent` member is a 403 verification failure with a body-aware `Accept-Signature` rather than a 400; and `signWebBotAuth` (and so `createWebBotAuthFetch`) refuses to replace existing signature fields unless `relay: true`, and reports a relay without prior fields as a `TypeError`.
