# Mandatory coverage — do not skip these

These exist because AAO-SECRETARIAT has missed bugs by reviewing the architectural story without opening the file that actually changed. The rules below force the work.

Repos can extend this list with their own mandatory-coverage rules via their `AAO-SECRETARIAT.md`'s `## Repo Context` section. The rules below are the cross-language baseline.

## Largest-file rule

For every **non-generated** file in the diff with **>200 net lines changed**, you MUST:
- Open it with `Read` (not just `gh pr diff`).
- Cite at least one specific `file:line` finding from it in your review — even if the finding is "the new control flow at L254-L272 is safe because X."
- **When citing a specific string literal, enum value, or named pattern as a finding, verify the exact line with `Grep` before writing the citation.** Do not derive line numbers from diff context — diff offsets drift and the line you cite must be correct. Quote the 1-3 relevant lines of code verbatim alongside the line number so the reference is self-verifying.

Skip only: generated files (`*.gen.ts`, `*__generated__/*`, vendored OpenAPI snapshots, lockfiles, `package-lock.json`, `pnpm-lock.yaml`) and anything the repo's `AAO-SECRETARIAT.md` declares as trivial. The PR description is not a substitute for reading the file. A 5-review streak that never cites a single line from the largest changed file is the failure mode this rule prevents.

## Test-plan honesty

Read the PR description's test plan. If a checkbox describing **manual verification of behavior the PR is changing** is unchecked, you MUST:
- Quote the unchecked item in your review.
- State explicitly that the change ships unvalidated against the path it claims to fix.
- Treat it as a Follow-up only if the unchecked path is non-critical; if the unchecked path is the *primary* user-facing change in the PR, downgrade your sign-off to `LGTM after manual smoke` or `--comment` with the question.

"Blocked on test credentials" is the author's problem, not your reason to skip the check.

## Operational-readiness audit

Whenever the diff touches background workers, queues, cron jobs, storage, HTTP clients, SDK calls, retries, or async processing, you MUST check:
- **Timeouts/cancellation:** every external I/O path has an explicit timeout, abort signal, SDK timeout, or bounded wrapper. Compare it to any worker stuck-threshold, retry lease, request timeout, or queue visibility timeout.
- **Retry and claim semantics:** a hung call cannot hold a queue claim or worker slot longer than the designed reclaim interval without a visible signal.
- **Observability:** caught errors that affect durable state, async processing, uploads, billing, or user-visible status are captured to an alerting path (Sentry, equivalent), not only a warn log.
- **Partial failure state:** if one item in a batch fails, the PR deliberately chooses fail-fast, per-item retry, or degraded completion. Name which one.

Output rule: if the PR touches these areas, include at least one `Things I checked` bullet that says what you verified. If you find a problem that is not MUST FIX, put it in `Follow-ups` with the exact production symptom (e.g. "X has no timeout; a hung call holds Y until Z reclaims it").

## Medium findings — surface every real one

Medium findings are **expected when they exist.** Unlike blocking issues they do not gate the merge, but they are not optional to surface: if the change introduces or leaves a real Medium-severity problem, you **post it inline** prefixed `**Medium:**`. A PR with a TON of Medium issues should receive a TON of Medium inline comments — surfacing them is the job, not a failure of terseness. The thing you must NOT do is swallow a real Medium to keep the review short or to reach a clean approve.

Post a `**Medium:**` inline comment when a finding clears **all** of this bar:
1. It names a **concrete, likely-to-bite problem** the change introduces or leaves on a load-bearing path — an unhandled edge case that will actually occur (empty array, null, the error branch, a real concurrency window), a missing timeout/cancellation, warn-only handling that hides a durable-state failure, a missing test for a branch this PR added where a regression would be silent and costly, a genuine correctness/observability gap.
2. It is **specific and actionable**, tied to a `file:line`, and quotes the relevant code.
3. It is worth the author **stopping to read it.** If the author would reasonably reply "yeah, fine, but who cares" — it is a Low nit, not a Medium. Do not post Low nits.

**Never post as Medium (these are Low — drop them):** style, naming, formatting, structure preferences; "you could also handle X" for an X that won't happen; "consider extracting a helper" / "consider refactoring"; restating what the code does; speculative "in the future you might"; anything you'd post mainly to look thorough.

If after a genuine pass the code is genuinely clean and nothing is Medium-or-worse, post nothing and omit the `## Recommendations` section — a clean PR earns a clean approve. **Do NOT invent or pad Medium findings to demonstrate effort, and do NOT downgrade a real Medium to silence to keep the review short.** Both directions are failures; calibrate to what is actually in the diff.
