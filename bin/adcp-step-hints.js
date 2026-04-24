/**
 * Human-console renderer for `StoryboardStepResult.hints[]` (adcp-client#879).
 *
 * Extracted from bin/adcp.js so the formatting logic is unit-testable
 * without spawning the CLI. The JUnit equivalent lives in
 * `src/lib/testing/storyboard/junit.ts` — it emits structured XML rather
 * than console lines, so the two surfaces don't share a helper.
 *
 * The runner populates `hints[]` when it can trace a seller rejection
 * back to a prior-step `$context.*` write (adcp-client#870). Surfacing
 * them on the CLI collapses "SDK bug vs seller bug" triage to one line.
 */

/**
 * Print each hint on its own line, prefixed with the hint icon. `indent`
 * should match the caller's `Error:` indent so hints group visually —
 * 3 spaces for the full storyboard printer (which nests steps under
 * phases), empty for the single-step printer (`adcp storyboard step`)
 * that prints error/validation lines at column zero.
 */
function printStepHints(hints, indent = '   ') {
  if (!Array.isArray(hints) || hints.length === 0) return;
  for (const h of hints) {
    console.log(`${indent}💡 Hint: ${h.message}`);
  }
}

module.exports = { printStepHints };
