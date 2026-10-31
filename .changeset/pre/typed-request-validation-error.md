---
'@adcp/sdk': minor
---

Throw a typed `RequestValidationError` when the client rejects a request against the request schema before sending it (#3378). It extends `ValidationError` (exported from the root as `ADCPValidationError`) and carries `code: 'VALIDATION_ERROR'`, `task`, and `fields` (JSON Pointers to the invalid fields). It never carries the submitted values. The message text is unchanged on both validation paths, so existing message matchers keep working. The generated-schema path used to throw a plain `Error`; it now throws an `ADCPError` subclass, so `isADCPError()` returns `true` for it.

Refusals the SDK decides locally, before any of the task's request is sent, now carry `dispatched: false`. A caller can tell them apart from agent failures without `instanceof` or message matching. The marked refusals are:

- request validation;
- `FeatureUnsupportedError` and `ProtocolFeatureUnsupportedError` (feature and release gates);
- `VersionUnsupportedError` where the client refuses a task based on capabilities it already holds.

`VersionUnsupportedError` takes a new options argument, `{ dispatched: false }`, so the marker is set per throw site.

Failures that involve contacting the agent are not marked:

- endpoint discovery and OAuth token fetches;
- the `get_adcp_capabilities` fetch, including its rejection of a v2 seller.

A refused connection, a 5xx or a 429 still counts as an agent failure. Refusing to resume a deferred task is not marked either, because the original task was sent.

The new `isPreDispatchError(error)` checks the marker. The storyboard runner now uses the marker to detect local schema refusals and falls back to the message match.

`ValidationError` takes an optional fourth `message` argument.
