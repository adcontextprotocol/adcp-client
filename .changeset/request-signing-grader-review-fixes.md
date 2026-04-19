---
'@adcp/client': minor
---

Request-signing conformance grader — review fixes.

Addresses findings from the six-agent expert review of PR #600. Behavioral
changes:

**Correctness**

- Skipped vectors now report as `skipped: true` through the storyboard
  runner instead of being scored as failures (previously `probe-dispatch.ts`
  set `HttpProbeResult.error` on skip, which the runner's `fetchOk` check
  treated as failed). Requires a new `HttpProbeResult.skipped` flag and
  `executeProbeStep` branch that bypasses validations for skipped probes.
- Synthesis failure now surfaces as a failing `synthesis_error` phase in
  the storyboard rather than a silent empty-phase fallback — CI pipelines
  would have seen green for an infrastructural bug.
- Vector 010 (`content-digest-mismatch`) now tests the intended invariant:
  the signer commits a wrong `Content-Digest` value (zero-byte digest) in
  the signature base, and the verifier's step-11 recompute fails. Previous
  mutation (append space to body post-sign) exercised a different bug
  class (body-tampered-in-transit) and would mask lying-signer detection
  in verifiers that recompute digest from the received body.
- Vector 009 (`key-purpose-invalid`) now honors the vector's pinned
  `jwks_ref` (`test-gov-2026`) directly instead of inferring a non-request-
  signing key from the keyset.

**Safety (live side effects)**

- Vectors 016 (`replay_window`) and 020 (`rate_abuse`) now auto-skip
  against non-sandbox endpoints unless the operator passes
  `allowLiveSideEffects: true`. The contract YAML's `endpoint_scope:
  sandbox` declaration satisfies the gate when present. Prevents
  accidental live `create_media_buy` creation or replay-cache flooding
  against production agents.
- `GradeReport.endpoint_scope_warning` → renamed to `live_endpoint_warning`
  and inverted to be `true` when the endpoint is NOT declared sandbox
  (the dangerous case). Prior semantics were misleading: the field read
  as "sandbox is bad."

**WWW-Authenticate parser hardening**

- `extractSignatureErrorCode` now constrains returned codes to the
  `[a-z0-9_]+` alphabet, rejecting malformed / adversarial values from
  untrusted agent headers. Downstream diagnostic strings and LLM-consumption
  paths are safe from smuggled content.
- `splitChallenges` now tracks quote state so adversarial `error="foo,
  Bar baz"` doesn't spuriously split mid-value.

**DX / ergonomics**

- New CLI: `adcp grade request-signing <agent-url>` with
  `--skip-rate-abuse`, `--rate-abuse-cap`, `--only`, `--skip`,
  `--allow-live-side-effects`, `--allow-http`, `--json`. Human-readable
  table output by default; exit code 0 on pass, 1 on fail, 2 on
  configuration error.
- `GradeReport` now carries `passed_count` / `failed_count` /
  `skipped_count` at the top level — no more client-side `reduce()` to
  enumerate.
- `GradeOptions.onlyVectors: string[]` filters to a subset of vector IDs
  (all others auto-skip) — simplifies isolated regression tests and
  replaces the three hand-maintained 19-entry skip arrays in the test
  suite.
- Barrel (`index.ts`) is now grouped as "Public API" / "Storyboard-runner
  hooks" / "Advanced harness building blocks" with a top-level module
  JSDoc and usage snippet.
- `BuildOptions.baseUrl` now prefixes the agent's mount path to the
  vector path, so agents served at `/v1/adcp/*` (not `/adcp/*`) receive
  requests at the right path.

**Hygiene**

- `ContractId` (`replay_window | revocation | rate_abuse`) is now a single
  source of truth in `types.ts` (was duplicated across three files).
- `AdcpJsonWebKey.d` is now an explicit optional field with JSDoc
  explaining its role instead of flowing through the index signature.
- `loadRequestSigningVectors` memoizes per-cacheDir. Previously every
  `gradeOneVector` call re-parsed 28 JSON fixtures + keys.json + YAML
  test-kit (compliance cache is immutable during a process lifetime).
- New test util `test/utils/reference-verifier.js` extracts the
  `startReferenceVerifier` + `makeExpressShim` pattern that previously
  appeared verbatim in three test files.
- Dispatch wire-up test: `runStoryboardStep` with a synthesized
  `request_signing_probe` step now has a dedicated test so someone
  removing the task from `PROBE_TASKS` or flipping the dispatch condition
  in `runner.ts` gets caught by CI.
