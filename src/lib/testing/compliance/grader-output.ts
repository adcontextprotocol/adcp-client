/**
 * Pass/fail predicate for `adcp storyboard run --json` output.
 *
 * Not re-exported from the compliance barrel — internal to the
 * `scripts/manual-testing` harness and exposed here only for testability.
 */

/** Parsed shape of `adcp storyboard run --json` output. */
interface GraderJSON {
  overall_status?: string;
  summary?: {
    steps_failed?: number;
    tracks_failed?: number;
    tracks_partial?: number;
    tracks_silent?: number;
  };
}

/** Return value of {@link evaluateGraderOutput}. */
export interface GraderEvaluation {
  passed: boolean;
  /** True when at least one track was classified as silent (wired but unobserved). */
  silentTracks: boolean;
}

/**
 * Determines whether a parsed `adcp storyboard run --json` response represents
 * a passing conformance run.
 *
 * Three shapes handled:
 * - `overall_status: 'passing'` → pass.
 * - `overall_status: 'partial'` with `tracks_silent > 0` and zero failed/partial
 *   tracks → pass (all-silent track case; see adcontextprotocol/adcp#2834).
 *   `tracks_silent > 0` is required to distinguish "wired but unobserved" from
 *   "attempted === 0" (wrong storyboard ID or discovery filtered everything), which
 *   also emits `partial` but must NOT be treated as a pass.
 * - No `overall_status` (pre-6.2 grader output) → pass when no track or step failures.
 *
 * A `partial` output with `tracks_partial > 0` or `tracks_failed > 0` is a real
 * mixed failure and is NOT treated as a pass.
 */
export function evaluateGraderOutput(parsed: GraderJSON): GraderEvaluation {
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { passed: false, silentTracks: false };
  }
  if (typeof parsed.overall_status === 'string') {
    if (parsed.overall_status === 'passing') {
      return { passed: true, silentTracks: false };
    }
    if (parsed.overall_status === 'partial' && parsed.summary != null && typeof parsed.summary === 'object') {
      const s = parsed.summary;
      const silentTracks = (s.tracks_silent ?? 0) > 0;
      const passed =
        silentTracks && (s.steps_failed ?? 0) === 0 && (s.tracks_failed ?? 0) === 0 && (s.tracks_partial ?? 0) === 0;
      return { passed, silentTracks };
    }
    // 'partial' without a summary block, or any other non-'passing' status → fail.
    return { passed: false, silentTracks: false };
  }
  // Fallback: no overall_status field (pre-6.2) — pass if nothing failed.
  if (parsed.summary != null && typeof parsed.summary === 'object') {
    const s = parsed.summary;
    return {
      passed: (s.steps_failed ?? 0) === 0 && (s.tracks_failed ?? 0) === 0,
      silentTracks: (s.tracks_silent ?? 0) > 0,
    };
  }
  return { passed: false, silentTracks: false };
}
