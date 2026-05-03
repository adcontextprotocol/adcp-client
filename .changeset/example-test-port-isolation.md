---
"@adcp/sdk": patch
---

Test-infrastructure: `runHelloAdapterGates` (the shared CI test runner for `examples/hello_*_adapter_*.ts`) picks free TCP ports per-run instead of taking hardcoded numbers from each test file's config.

Closes the EADDRINUSE-on-41504 + agent-port-timeout-on-35004 flakes hit on adcp-client#1361 CI runs 25266540111 / 25266762789 / 25266848405 — concurrent `node --test` workers were racing on the same hardcoded port across reruns when the previous run left TCP sockets in TIME_WAIT after `--test-force-exit`.

Mock server gets `port: 0` directly (its boot helper surfaces the bound port via `mockHandle.url`); the spawned agent reads `PORT` from env, so the harness uses a small `pickFreePort()` helper that asks the kernel for a free number and hands it to the child process. `agentPort` and `upstreamPort` are gone from the `runHelloAdapterGates` config — every test file using the harness now opts in automatically.

No library/CLI behavior change; this is a `patch` only because the changeset gate doesn't have a "tests-only" semver level today.
