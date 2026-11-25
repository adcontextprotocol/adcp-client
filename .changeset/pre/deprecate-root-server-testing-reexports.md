---
'@adcp/sdk': minor
---

Deprecate the server and testing names that the package root (`@adcp/sdk`) and `@adcp/sdk/client` re-export (#3664). Each of the 275 names re-exported from `./server` and `./testing` (for example `serve`, `createTaskCapableServer`, `adcpError`, the `legacy*Response` builders, the idempotency and state stores, `ServeContext`, `mediaBuyActionResolver`, `testAgent` and `createTestAgent`) now carries `@deprecated` pointing at `@adcp/sdk/server` or `@adcp/sdk/testing`. Runtime behavior is unchanged in 17.x. SDK 18.0 removes these re-exports so that `.` and `./client` stop loading the server and testing modules. The root aliases `StateListOptions` and `StateListResult` map to `ListOptions` and `ListResult` on `@adcp/sdk/server`. Repo docs, skills and examples now import these names from the subpaths. See "Server and testing names on the root entry are deprecated" in `docs/migration-16-to-17.md`.
