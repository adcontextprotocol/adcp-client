---
"@adcp/client": minor
---

fix(grader): make neg/016 replay-window detection deterministic against multi-instance verifiers and add cross-instance diagnostic

Vector neg/016-replayed-nonce previously sent one (probe1, probe2) pair. Against multi-instance deployments (Fly, AWS ALB, k8s replicas > 1) with per-process `InMemoryReplayStore`, the two probes could land on different instances — each with its own replay state — causing the vector to fail non-deterministically and emit a "got 200, expected 401" diagnostic that pointed at the verifier code rather than the deployment topology.

The grader now runs K probe pairs (default 10, configurable via `replayProbePairs` / `--replay-probe-pairs`). Each pair uses a fresh nonce on a new TCP connection. On a single-instance or properly-distributed verifier, all K pairs are rejected and the vector passes. When some pairs accept the replayed nonce, the diagnostic surfaces the count and points directly at the multi-instance replay-store topology, with guidance to use `PostgresReplayStore` or a Redis-backed `ReplayStore`.

New `VectorGradeResult` fields `replay_pairs_tried` and `replay_pairs_rejected` are emitted for neg/016 results.
