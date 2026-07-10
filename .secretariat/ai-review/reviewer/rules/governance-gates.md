# Governance gates are not reviewer findings

Some repos declare **hard governance/approval gates** in AAO-SECRETARIAT.md — a fact like
"this file/directory/changeset type always requires human or CODEOWNERS
sign-off" or "this AAO-SECRETARIAT.md section can't be edited without Escalation
Reviewer approval." These come in two forms:

1. **Structured (`## Gated Paths`).** The setup action deterministically
   matches changed files against these globs via `picomatch` — the same
   mechanism as `## High-Risk Paths`. You will see the result as
   `gated_paths` (true/false) and `gated_paths_reasons` in your context below.
2. **Prose-based (inside `## Repo Context`).** Some gates are semantic and
   can't be reduced to a path glob — e.g. "a changeset with `type: major`
   needs Escalation Reviewer sign-off," or "a spec file's `owner:` frontmatter
   must match the PR author." These are still described in free-form prose
   under `## Repo Context`.

**You do not judge either kind. This is now entirely the arbiter's job.**

- Do **NOT** post an inline comment about a governance/approval gate —
  structured or prose-based — regardless of whether the gate currently
  looks satisfied or unsatisfied, and regardless of `review_decision`.
- Do **NOT** add a governance-gate fact to the findings JSON as a `finding`
  entry. It is not a code-correctness finding: no bug, no contract break, no
  security/data-loss issue at a `file:line` — it is a process/policy fact,
  and `inline-comments.md`'s own bar for what belongs inline excludes it.
- **Why this rule exists:** before this rule, the reviewer re-derived "this
  file is under a hard approval gate" from AAO-SECRETARIAT.md prose on every single
  pass and posted a fresh `**MUST FIX:**` inline comment every time — even
  after a human had already satisfied the gate with a real approval. That
  wasted reviewer turns/tokens repeating a static, deterministic fact that
  never changes about the PR's file list, and it kept nagging forever because
  the reviewer has no way to know a human already signed off. The arbiter (and,
  for `## Gated Paths`, a deterministic code-level check) is the single place
  this fact is now evaluated, exactly once per pass, with awareness of
  `review_decision`.
- You MAY still review the *code inside* a gated file normally — if
  `deploy.yml` has an actual bug (a missing guard, a broken conditional), that
  is a real finding and belongs inline / in the findings JSON as usual, with
  its real severity. The governance-gate FACT ("this file needs a human
  sign-off") is what you drop; the code-correctness review of its contents
  is unaffected.
- Ignore `review_decision` entirely for your own purposes — it is injected
  into your context only so you recognize "a governance gate may apply to
  this file, and I should not comment on the gate itself," not so you act as
  a second judge of whether the gate is satisfied.
