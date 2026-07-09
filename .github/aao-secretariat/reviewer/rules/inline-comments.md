# Inline comments — pin findings to the exact line

**Inline comments put findings on the code they are about.** Two tiers of finding belong inline, each on its specific line:

1. **MUST FIX (Critical / High) — blocking.** Prefix `**MUST FIX:**`. A reproducible bug, contract break, security/billing/data-loss issue with a named `file:line`. Never dropped, always inline.
2. **Medium — non-blocking but surfaced.** Prefix `**Medium:**`. Unhandled edge cases, missing timeouts, warn-only error handling on load-bearing paths.

**Inline is still not a nit dump.** Low-severity items — style, naming, formatting, "you could also," speculative "in the future you might," restating what the code does — do NOT go inline. The signal of an inline comment is "stop and look at this line." Low-value comments dilute that signal and train the author to ignore AAO-SECRETARIAT. Post Critical / High / Medium findings; drop the Low ones or fold a genuinely load-bearing one into the summary.

**Rules:**
- Only comment on lines that appear in the PR diff (lines with `+` prefix in the unified diff output). GitHub rejects comments on lines outside the diff hunk.
- The `line` number is the line number in the NEW version of the file (the right-side number shown in `gh pr diff` output).
- Each inline comment must be self-contained — a reader should understand the concern without reading the summary body.
- Use the AAO-SECRETARIAT voice. Keep comments concise: 1–3 sentences max.
- Prefix blocking comments with `**MUST FIX:**` and Medium comments with `**Medium:**`. Use `**(non-blocking)**` only for the rare load-bearing Low nit.
- **No hard cap on Critical / High / Medium findings — surface every real one.** A PR that genuinely has a TON of Medium and High issues should get a TON of inline comments; do not ration them down to look terse. The only thing you ration is Low-severity nits — keep at most a few of those, and only if load-bearing. Never pad to a count, and never drop a real Medium to stay under one.
- If a `gh api` comment call fails (e.g. the line is not in the diff), skip it and note the finding in the summary body instead.

**What stays in the summary body (keep it short):**
- The verdict and sign-off
- "Things I checked" bullets
- Cross-cutting concerns that genuinely span multiple files and cannot be pinned to one line
- Findings on lines not in the diff (reference as `file:line` in prose)
- Follow-ups about missing functionality (not tied to a specific line)

A blocking or Medium issue on a line belongs inline. A passing thought about how the code could be marginally nicer belongs nowhere.

---

## How to post

Use the `mcp__github_inline_comment__create_inline_comment` tool with `confirmed: true`. For each inline comment, also include a corresponding entry in the findings JSON emitted at end-of-run (with `posted_inline: true`). For findings that don't merit an inline (architecture-level, cross-file concerns), include them in the JSON with `posted_inline: false`.
