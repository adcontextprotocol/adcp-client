---
'@adcp/sdk': minor
---

Backport native A2A 1.0 grading to the maintained 13.x runner while preserving the public A2A 0.3 dependency and server/client surface. Native A2A grading uses the official 1.0 client by default; use `--a2a-legacy-compat` to grade the maintained 13.x A2A 0.3 server adapter or another 0.3-only agent. MCP grading continues through the official MCP SDK.

The conformance runner now skips flattened-URL signing vectors 009–012 for both MCP and A2A, with the existing MCP reason retained and a transport-neutral A2A reason. A2A signing probes capture the exact official-client request bytes and send push-notification registration through the transport configuration used at runtime while retaining the full AdCP application registration (including `operation_id`) in native skill input. Strict native A2A refuses credentialed cross-origin endpoints; stable legacy A2A and MCP preserve redirect compatibility by stripping authentication and all caller-configured headers before crossing origins while preserving them same-origin.

This release also adds the public structured skip reason/API surface used by those results, exact compliance-version/cache/schema selection for historical data, and release automation for the real `adcp-3.1` npm compatibility tag. The package bundles compliance caches 3.0.12, 3.1.20, and 3.2.0; exact 3.1.1 grading requires matching external compliance and schema roots.
