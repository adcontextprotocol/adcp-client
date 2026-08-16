---
'@adcp/sdk': patch
---

fix(oauth): require browser state binding in `completeWebOAuthFlow`

`CompleteWebFlowOptions.expectedState` was optional and silently skipped when absent — the flow was replay-protected via atomic consume but not browser-bound. Now:

- Omitting `expectedState` throws `BrowserBindingRequiredError` by default. Pass the state from the session cookie created at `/oauth/start`.
- Trusted non-browser integrations can explicitly set `allowUnboundState: true`; browser handlers must not use this escape hatch.
- The deprecated `requireBrowserBinding` option remains accepted for source compatibility, but binding is now the default.
- New `BrowserBindingRequiredError` class is exported from `@adcp/sdk/auth/oauth`.

Parallels the `CLIFlowHandler` state-binding hardened in the same security PR.
