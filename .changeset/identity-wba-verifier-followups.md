---
'@adcp/sdk': patch
---

Experimental AdCP 3.3 Web Bot Auth fixes (follow-up to #3244): replay caches keep a nonce through the inclusive end of the acceptance window (WBA, RFC 9421 request and webhook verifiers), so a signature cannot be replayed at exactly `expires` plus skew; directory and signing-fetch bodies keep a UTF-8 BOM so digests cover the exact bytes; signed directories backdate `created` by 60 seconds and verifiers tolerate that skew; a `web-bot-auth` tagged request missing `Signature-Agent` (or another required field) is a 403 verification failure rather than a 400; and `signWebBotAuth` refuses to replace existing signature fields unless `relay: true`.
