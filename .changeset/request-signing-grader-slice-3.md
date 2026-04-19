---
'@adcp/client': minor
---

Request-signing conformance grader — Slice 3: storyboard-runner integration.

The signed-requests specialism YAML declares `positive_vectors` and
`negative_vectors` phases whose steps are synthesized at runtime from the
test-vector fixtures (the spec deliberately avoids duplicating fixture data
in YAML). This change wires those synthesized steps into the storyboard
runner so `get_adcp_capabilities` → run-storyboard pipelines grade an agent's
RFC 9421 verifier as part of a normal compliance run.

Changes:

- **Synthesizer** (`storyboard/request-signing/synthesize.ts`): expands
  `positive_vectors` / `negative_vectors` phases with one
  `request_signing_probe` step per vector on disk. Step IDs follow a
  `positive-<vector>` / `negative-<vector>` convention that the dispatch
  helper decodes. `skipVectors` option filters at synthesis time.
- **Compliance loader** hooks synthesis into `loadBundleStoryboards` so
  callers (runner, CLI tools, reporting) see a fully populated storyboard.
  Falls back to the unsynthesized form with a warning if the compliance
  cache is missing vectors.
- **Loader** (`storyboard/loader.ts`) now tolerates phases with no `steps:`
  key — the signed-requests YAML is the first specialism to ship such
  phases.
- **Probe dispatch** (`storyboard/request-signing/probe-dispatch.ts`): new
  `request_signing_probe` entry in `PROBE_TASKS`. The dispatcher decodes
  the step ID, runs the grader's per-vector logic
  (`gradeOneVector`), and maps the `VectorGradeResult` to an
  `HttpProbeResult`-shaped return so the existing validation pipeline
  (`http_status`, `http_status_in`) works unchanged.
- **StoryboardRunOptions** gains a `request_signing?` block —
  `skipRateAbuse`, `rateAbuseCap`, `skipVectors` — so operators can tune
  the grader without forking the runner.

Integration tests at `test/request-signing-runner-integration.test.js`:
verify synthesis produces the right step count/IDs, exercise the probe
dispatch against a reference verifier (positive accept, negative reject
with matching WWW-Authenticate, skip-rate-abuse, skip-vectors, unknown
step ID, capability-profile mismatch surfaces as a probe error).

With this slice, `compliance/specialisms/signed-requests/index.yaml` runs
end-to-end through the existing storyboard runner — no specialism-specific
entry point required.
