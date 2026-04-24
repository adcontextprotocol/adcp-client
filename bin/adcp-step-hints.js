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

const HINT_LABEL = '💡 Hint: ';
// `💡` renders as a single visible glyph but is a surrogate pair (2 UTF-16
// code units). For continuation-line alignment we want N visible columns of
// padding to match the prefix's visible width. Hardcoded rather than
// computed via grapheme APIs because it's stable.
const HINT_LABEL_VISIBLE_WIDTH = 9; // "💡 Hint: " = 1 emoji + 8 ASCII chars
const FALLBACK_WIDTH = 100;
const MIN_BODY_WIDTH = 40;

/**
 * Resolve the wrap target. Prefer the live TTY width; fall back to the
 * `COLUMNS` env var (commonly set by `tput`-aware shells); otherwise 100
 * (a comfortable read width that doesn't waste space on wide terminals).
 */
function resolveWidth() {
  if (process.stdout.isTTY && typeof process.stdout.columns === 'number' && process.stdout.columns > 0) {
    return process.stdout.columns;
  }
  const env = Number.parseInt(process.env.COLUMNS ?? '', 10);
  if (Number.isFinite(env) && env > 0) return env;
  return FALLBACK_WIDTH;
}

/**
 * Word-wrap `text` at `bodyWidth` characters, preserving existing
 * whitespace runs and never breaking inside a `\`code\`` segment unless
 * the segment itself exceeds the line width. Returns an array of lines
 * (no leading whitespace; caller adds indent).
 */
function wrap(text, bodyWidth) {
  if (bodyWidth <= 0) return [text];
  // Tokenize on word boundaries but keep adjacent backtick-fenced segments
  // bound to their preceding word so a backtick run doesn't wrap mid-token.
  // Simpler heuristic: split on spaces, but don't insert a break inside a
  // run that's bounded by an unbalanced backtick — count backticks as we go.
  const words = text.split(/(\s+)/).filter(s => s.length > 0);
  const lines = [];
  let line = '';
  // Track whether the line *currently being built* has an unclosed
  // backtick. If so, the next non-whitespace token glues to the line
  // (closing the run) regardless of width — splitting an identifier
  // mid-`backtick` would render as two unbalanced fragments.
  let openTickInLine = false;
  for (const tok of words) {
    const isWS = /^\s+$/.test(tok);
    if (isWS) {
      // Whitespace either continues the line, or — if we'd otherwise
      // overshoot AND we're not in the middle of a fenced run — drops
      // and forces a wrap. Keeping it on the line is fine when the next
      // word fits.
      if (!openTickInLine && line.length + tok.length > bodyWidth) {
        lines.push(line.trimEnd());
        line = '';
        continue;
      }
      line += tok;
      continue;
    }
    if (line.length === 0) {
      line = tok;
      const ticks = (tok.match(/`/g) ?? []).length;
      if (ticks % 2 === 1) openTickInLine = !openTickInLine;
      continue;
    }
    if (openTickInLine) {
      // Glue to the current line until the fence closes.
      line += tok;
      const ticks = (tok.match(/`/g) ?? []).length;
      if (ticks % 2 === 1) openTickInLine = !openTickInLine;
      continue;
    }
    if (line.length + tok.length > bodyWidth) {
      lines.push(line.trimEnd());
      line = tok;
      const ticks = (tok.match(/`/g) ?? []).length;
      if (ticks % 2 === 1) openTickInLine = !openTickInLine;
      continue;
    }
    line += tok;
    const ticks = (tok.match(/`/g) ?? []).length;
    if (ticks % 2 === 1) openTickInLine = !openTickInLine;
  }
  if (line.length > 0) lines.push(line.trimEnd());
  return lines;
}

/**
 * Print each hint on its own block, prefixed with the hint icon. `indent`
 * should match the caller's `Error:` indent so hints group visually —
 * 3 spaces for the full storyboard printer (which nests steps under
 * phases), empty for the single-step printer (`adcp storyboard step`)
 * that prints error/validation lines at column zero.
 *
 * Long messages are word-wrapped to the terminal width (or 100 cols when
 * stdout isn't a TTY) with continuation lines aligned under the message
 * text, so a wrapped hint reads as a paragraph rather than a runaway line:
 *
 *   💡 Hint: Rejected `pricing_option_id: po_x` was extracted from
 *           `$context.first_signal_pricing_option_id` (set by step
 *           `discover` from response path `signals[0]...`). Seller's
 *           accepted values: [po_y]. Check that the seller's
 *           `get_signals` and `activate_signal` catalogs agree.
 */
function printStepHints(hints, indent = '   ') {
  if (!Array.isArray(hints) || hints.length === 0) return;
  const width = resolveWidth();
  // Body width = total - indent - "💡 Hint: " prefix; clamp so we never
  // produce a body of 1–2 chars on a freakishly narrow terminal.
  const bodyWidth = Math.max(MIN_BODY_WIDTH, width - indent.length - HINT_LABEL_VISIBLE_WIDTH);
  const continuationIndent = indent + ' '.repeat(HINT_LABEL_VISIBLE_WIDTH);
  for (const h of hints) {
    const message = typeof h?.message === 'string' ? h.message : '';
    const lines = wrap(message, bodyWidth);
    if (lines.length === 0) continue;
    console.log(`${indent}${HINT_LABEL}${lines[0]}`);
    for (let i = 1; i < lines.length; i++) {
      console.log(`${continuationIndent}${lines[i]}`);
    }
  }
}

/**
 * Count the total hints across every phase × step in a `StoryboardResult`.
 * Used by the run-summary line so operators see at a glance whether the
 * runner emitted any diagnostics, without scrolling the per-step output.
 */
function countHintsInResult(result) {
  if (!result || !Array.isArray(result.phases)) return 0;
  let n = 0;
  for (const phase of result.phases) {
    for (const step of phase.steps ?? []) {
      n += Array.isArray(step.hints) ? step.hints.length : 0;
    }
  }
  return n;
}

module.exports = { printStepHints, countHintsInResult };
