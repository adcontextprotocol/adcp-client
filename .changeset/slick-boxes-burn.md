---
'@adcp/sdk': minor
---

feat: bump ADCP_VERSION to 3.0.12 + wire comply_controller_mode_gate denial storyboard

Adopts the new universal storyboard from adcp#4028 (the live-mode `comply_test_controller` denial gate) as a graded path on `hello_seller_adapter_guaranteed`. The bump unblocks the storyboard end-to-end against framework-gated sellers; the SDK changes below close the wire-level gaps that surfaced during integration.

- **Schema cache:** `ADCP_VERSION` 3.0.11 → 3.0.12; `npm run sync-schemas` pulls the new universal storyboard (`comply-controller-mode-gate.yaml`) and test-kit (`acme-outdoor-live.yaml`).
- **Framework gate echoes context/ext on FORBIDDEN refusal** (`src/lib/server/decisioning/runtime/from-platform.ts`). The `comply_test_controller` live-mode gate previously dropped the request's `context` and `ext` on refusal; the denial storyboard asserts `context.correlation_id` round-trips, so the gate now mirrors them onto the ControllerError envelope.
- **`rawMcpProbe` parses Streamable-HTTP MCP SSE responses** (`src/lib/testing/storyboard/probes.ts`). Strict MCP servers (the official SDK and `createAdcpServer`) require clients to advertise `Accept: application/json, text/event-stream` and respond to `tools/call` with a single SSE `event: message` whose `data:` line is the JSON-RPC envelope. The probe now sends both `Accept` values and parses the first `data:` line when the response is `text/event-stream`. Storyboards that set `step.auth` (and therefore route through the raw probe) now grade against Streamable-HTTP MCP servers; the previous JSON-only behavior 406'd silently.
- **`adcp storyboard run --test-kit PATH`** (`bin/adcp.js`). Loads a test-kit YAML and threads it into `runStoryboard` / `runFullAssessment`'s `options.test_kit`, so storyboard steps with `auth.from_test_kit: true` or `$test_kit.<path>` references resolve from the CLI.
- **Worked example wires the live-mode probe principal** (`examples/hello_seller_adapter_guaranteed.ts`). Registers `demo-acme-outdoor-live-v1` as a second bearer; the resolver stamps `mode: 'live'` when that token authenticates the request, triggering the framework gate's `FORBIDDEN` refusal.
- **CI gate added** (`test/examples/hello-seller-adapter-guaranteed.test.js`, helper `_helpers/runHelloAdapterGates.js`). `extraStoryboards` parameter on the gate helper runs the denial storyboard against the same agent process. The denial gate fails closed if the framework regresses on the gate, the context echo, or the SSE probe parsing.

Closes #1522.
