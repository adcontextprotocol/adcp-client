---
"@adcp/sdk": patch
---

docs: add basic-auth gateway setup guide and auth_token-suppression JSDoc

Adds `docs/guides/BASIC-AUTH.md` covering when to use `--auth-scheme basic`, the
CLI worked example, and the load-bearing invariant that `auth_token` is suppressed
when basic auth is active so the SDK does not emit a competing `Authorization: Bearer`.

Cross-references added to `docs/CLI.md` (new `--auth-scheme basic` paragraph under
Authentication Methods), `docs/llms.txt` (Transport auth section), and a JSDoc note
on `SingleAgentClient.getAgentInfo` pointing to the invariant and guide.
