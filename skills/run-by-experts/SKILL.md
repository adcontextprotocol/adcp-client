---
name: run-by-experts
description: Use before opening a PR (especially for protocol/safety/correctness changes). Fires multiple expert reviewers in parallel and uses convergence as the blocker signal — items flagged by 2+ reviewers are real; single-reviewer findings are usually preferences.
---

# Run by Experts

## Overview

Multi-reviewer parallel review where **convergence is the load-bearing signal**. Items flagged by two or more reviewers are real blockers. Single-reviewer findings are usually preferences worth considering but not gating.

This skill exists because solo Claude review on a non-trivial PR catches obvious bugs but misses domain-specific landmines (multi-tenant isolation, protocol shape, type-system gotchas, adopter-DX cliffs). Each expert reviewer carries different domain priors; running them in parallel and acting on the intersection produces a better signal than any single review.

## When to use

**Always run before opening:**

- Protocol-level changes (request/response shapes, error codes, new specialism interfaces)
- Multi-tenant or auth surfaces (isolation gates, credential handling, sandbox boundaries)
- Adopter-facing examples (`examples/hello_*`, skill files, public docs)
- Bug fixes where the root cause might be either side of an interface boundary

**Optional but high-value:**

- Refactors that span multiple specialism modules
- API surface changes (export shape, type changes, deprecations)
- New subagent prompts or skill files

**Skip:**

- Trivial changes (changesets, single-line bug fixes with obvious test coverage, README typos)
- Pure mechanical refactors (rename, dead-code removal) where you've verified no behavior change

## The reviewer set

Pick the relevant subset for the PR. Default for a substantive change is all four:

| Reviewer                  | Focus                                                                                                       | Fire when                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `ad-tech-protocol-expert` | Wire shape vs spec, error code placement, schema conformance, protocol contract                             | Any protocol-touching change                                                                        |
| `code-reviewer`           | Correctness, type-safety, dead code, casts, edge cases, hidden control flow                                 | All non-trivial code changes                                                                        |
| `security-reviewer`       | Tenant isolation, auth/credential handling, prompt-injection surfaces, fail-open vs fail-closed gates, SSRF | Any change that touches auth, multi-tenancy, or buyer-supplied data flowing through error envelopes |
| `dx-expert`               | Forkability, SWAP markers, header doc clarity, copy-paste anti-patterns, README discoverability             | Any adopter-facing example or doc change                                                            |

For protocol-only / spec-side changes, `adtech-product-expert` (buy-side / sell-side product fit) is often a fifth.

## How to fire

Single message, multiple `Agent` tool calls in parallel — never sequential. Run-in-background unless the PR is so small that you'll wait on the first one. Each prompt is **self-contained**: the agent has no memory of the conversation, so include:

- File paths in scope
- Branch name
- Specific items the prior round (if any) claimed to fix — verify each
- Specific concerns you want flagged (don't ask "what do you think?" — that produces shallow review)
- Word budget ("Under 500 words")
- Format expectation ("Report: blockers / concerns / fine, per item")

Example brief shape (excerpted from `bokelley/hello-adapters-gov-rights` round 2):

> Re-review of PR #XXXX. Prior round flagged 17 findings; all blockers + must-fix concerns claimed addressed. Verify, and flag any NEW issues introduced by the fixes.
>
> Files in scope: `examples/foo.ts` (new, ~1200 lines).
>
> Prior-round items that should be fixed — verify each:
>
> 1. ...
> 2. ...
>
> New questions for this round:
>
> 1. ...
>
> Report: blockers / suggestions / nits. Under 500 words. Don't restate prior-round findings unless the fix introduces a new issue.

## Reading the results

**Convergence (2+ reviewers same finding) = real blocker.** Act on these unconditionally.

**Single-reviewer must-fix = should-fix.** Read the reasoning; usually it's worth doing but defensibly skippable. Push back if the finding contradicts the convergent signals.

**Advisory = nice-to-have.** Roll into a follow-up issue or comment-only fix.

The convergence signal is doing real work. From the production example (round 1 of the multi-tenant adapter PR):

- The `as unknown as { account?: ... }` cast was flagged by THREE of four reviewers (code: "may be reading a runtime-undefined field"; DX: "cargo-cult-bait"; protocol: implicitly endorsed by saying "should pull from `ctx.account`"). All three independently spotted that the cast was a real bug, not a style preference.
- Single-reviewer concerns were mostly preferences (helper extraction style, comment placement nits). Worth doing but not gating.

## Two-round pattern

For substantive PRs, run **two rounds**:

1. **Round 1 — initial review.** Fire all relevant reviewers on the unreviewed code. Consolidate findings by convergence. Apply blockers + must-fix.
2. **Round 2 — re-review of fixes.** Fire the same reviewers again, asking each to (a) verify each prior-round finding is fixed and (b) flag any NEW issues the fix introduced.

Round-2 finds the regressions fix-blindness misses. Production example: round 2 caught a fail-OPEN tenant gate that round 1's fix had introduced (the gate was `if (homeTenantId && tenantId !== homeTenantId)` — when `homeTenantId` is undefined, the check skips; round 1 hadn't considered that path).

## Process artifacts to ship with the PR

After all rounds land, the PR description should include:

- A consolidated "Expert review" section listing each round's blockers and how each was addressed
- The reviewer convergence signal (e.g., "3 of 4 flagged X" → "this was the real bug")
- Any single-reviewer items that were intentionally NOT fixed, with reasoning
- Cross-links to upstream-spec issues filed during review (if storyboards or spec gaps surfaced — see `skills/triage-storyboard-failure/`)

## What this skill is NOT

- A replacement for human reviewers — convergent expert review surfaces issues fast, but humans make the final call on whether to merge
- An excuse to skip writing tests — reviewers can't verify behavior they can't run
- A substitute for `npm run typecheck` / `npm run format:check` / CI — those gate-before-review

## See also

- `skills/triage-storyboard-failure/` — when an expert review (or your own testing) surfaces a storyboard-vs-spec mismatch
- `examples/CONTRIBUTING.md` — the SWAP-marker and DO-NOT-DEPLOY-AS-IS conventions DX reviewers will check for
- `~/.claude/commands/prep-for-pr.md` (personal command) — calls this skill plus the build/test/security-review chain
