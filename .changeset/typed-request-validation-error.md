---
'@adcp/sdk': minor
---

Throw a typed `RequestValidationError` when the client rejects a request against the request schema before sending it (#3378). It extends `ValidationError` (exported from the root as `ADCPValidationError`) and carries `code: 'VALIDATION_ERROR'`, `task`, and `fields` (JSON Pointers to the invalid fields). It never carries the submitted values. The message text is unchanged on both validation paths, so existing message matchers keep working.

Failures before dispatch now carry `dispatched: false`, so a caller can tell "the client never sent this request" from an agent failure without `instanceof` or message matching. This covers request validation, `VersionUnsupportedError` (version check), `FeatureUnsupportedError` and `ProtocolFeatureUnsupportedError` (feature and release gates), and endpoint discovery failures on task calls. Endpoint discovery may itself reach the agent, so `dispatched: false` means this request changed nothing on the agent, not that the agent is healthy. The new `isPreDispatchError(error)` checks the marker. The storyboard runner now uses the marker to detect local schema refusals and falls back to the message match.

`ValidationError` takes an optional fourth `message` argument.
