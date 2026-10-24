---
'@adcp/sdk': patch
---

Preserve producer evidence when prepared fixture discovery fails (#3385).

Authorized full and standalone reuse now retain fixture-handle resolutions and a `fixture_preparation` diagnostic phase with the producer's errors and actual exchanges. The historical phase is outside graded `phases`, preserving consumer and JUnit failure counts. Protected captures are stripped from its public contexts; denied callers still receive only `PreparedFixturesDeniedError`, while the private audit sink retains failed producer evidence.

Discovery failures identify the attempted task and configured transport. SDK connection errors are never represented as seller responses, protocol rejections remain protocol failures, and malformed seller pages retain a schema diagnostic against the actual received payload before SDK projection. The terminal failed page is retained even beyond the bounded successful-page evidence history. Captured text payloads redact credential fields.
