---
'@adcp/client': minor
---

Request-signing conformance grader — Slice 2: standalone grader orchestrator
and end-to-end smoke test against the reference verifier.

New module surface under `src/lib/testing/storyboard/request-signing/`:

- **Test-kit loader** (`test-kit.ts`): parses the signed-requests-runner harness
  contract YAML shipped by adcp#2353. Typed access to the runner's signing
  keyids, replay-window contract, revocation contract, and rate-abuse contract
  (with production-cap vs grading-cap fields kept separate per the spec).
- **HTTP probe** (`probe.ts`): sends a `SignedHttpRequest` to the agent and
  captures status + `WWW-Authenticate` error code. Reuses the SSRF guards
  from `storyboard/probes.ts` (DNS pin, private-IP block, IMDS always-block,
  64 KiB body cap, 10 s timeout, `redirect: 'manual'`).
- **Grader orchestrator** (`grader.ts`): `gradeRequestSigning(agentUrl, options)`
  runs all 28 conformance vectors in black-box mode. Handles the stateful
  contracts natively — vector 016 uses the replay-window repeat-request
  behavior, 017 uses the pre-revoked keyid, 020 fills the per-keyid cap then
  probes cap+1 — and emits per-vector diagnostics keyed to the spec error
  codes. `skipRateAbuse`, `rateAbuseCap`, and `skipVectors` options let
  operators tune to their agent's configuration.
- **Base-URL retargeting** in the builder: the vectors target
  `seller.example.com`, but real agents live elsewhere. `BuildOptions.baseUrl`
  swaps the origin into the agent's URL before signing so signatures match
  the URL the grader actually POSTs to.

Integration test at `test/request-signing-grader-e2e.test.js` stands up a
reference verifier (the #587 Express middleware) on localhost and grades
against it. Covers the capability-either profile on 17 non-stateful negatives
+ replay/revocation + 8 positives, plus dedicated tests for the
content-digest `required`/`forbidden` capability profiles and the rate-abuse
contract with matched caps. Verifies the full loader → builder → probe →
grader pipeline catches the step-ordering guarantees of the checklist (9/9a
before 10, 12 before 13) and the WWW-Authenticate byte-for-byte match.

Storyboard-runner integration (synthesizing per-vector steps into the YAML
runner's phase structure) is deferred to Slice 3 so it can land as a
focused change touching `runner.ts` / `probes.ts` / `compliance.ts`.

Not yet a CLI entry point — consume via `loadRequestSigningVectors` /
`gradeRequestSigning` from
`@adcp/client/testing/storyboard/request-signing` (internal module path).
