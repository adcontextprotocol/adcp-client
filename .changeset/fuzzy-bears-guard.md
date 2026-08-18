---
'@adcp/sdk': patch
---

Fail closed around compliance-only test surfaces. Seeded test-controller fixtures now require a trusted resolved sandbox or mock account, including for account-less tools.

`createComplyController(...).register(server)` previously warned but still exposed the controller when `sandboxGate` was omitted. It now throws unless the process is both `NODE_ENV=test|development` and explicitly acknowledged with `ADCP_COMPLY_CONTROLLER_UNGATED=1`. Existing direct registrations must add a gate that closes over trusted server-side deployment/auth state; per-principal adopters should use `createAdcpServerFromPlatform(platform, { complyTest })` for its resolved-account gate.
