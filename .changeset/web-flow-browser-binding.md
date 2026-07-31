---
"@adcp/sdk": patch
---

feat(oauth): add `requireBrowserBinding` and warn when `expectedState` is omitted from `completeWebOAuthFlow`

`CompleteWebFlowOptions.expectedState` was optional and silently skipped when absent — the flow was replay-protected via atomic consume but not browser-bound. Now:

- Omitting `expectedState` emits a `console.warn` pointing callers to the session-cookie pattern.
- Setting `requireBrowserBinding: true` promotes the omission to a `BrowserBindingRequiredError` (strict mode for frameworks where session cookies are always available).
- New `BrowserBindingRequiredError` class is exported from `@adcp/sdk/auth/oauth`.

Parallels the `CLIFlowHandler` state-binding hardened in the same security PR.
