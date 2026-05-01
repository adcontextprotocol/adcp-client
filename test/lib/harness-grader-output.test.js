'use strict';
/**
 * Unit tests for evaluateGraderOutput — the pass/fail predicate used by
 * runGrader in scripts/manual-testing/agent-skill-storyboard.ts.
 *
 * Covers the fix for issue #1209: overall_status:'partial' with all-silent
 * tracks (steps_failed=0, tracks_failed=0, tracks_partial=0) must be treated
 * as a pass, not a failure.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { evaluateGraderOutput } = require('../../dist/lib/testing/compliance/grader-output.js');

describe('evaluateGraderOutput', () => {
  describe('overall_status: passing', () => {
    it('returns passed=true, silentTracks=false', () => {
      const result = evaluateGraderOutput({
        overall_status: 'passing',
        summary: {
          tracks_passed: 2,
          tracks_failed: 0,
          tracks_partial: 0,
          tracks_silent: 0,
          steps_passed: 6,
          steps_failed: 0,
        },
      });
      assert.equal(result.passed, true);
      assert.equal(result.silentTracks, false);
    });

    it('passes even without a summary block', () => {
      const result = evaluateGraderOutput({ overall_status: 'passing' });
      assert.equal(result.passed, true);
      assert.equal(result.silentTracks, false);
    });
  });

  describe('overall_status: partial — all-silent tracks (issue #1209)', () => {
    it('returns passed=true when steps_failed=0, tracks_failed=0, tracks_partial=0', () => {
      // Exact fixture from the issue — creative-template run on PR #1207
      const result = evaluateGraderOutput({
        overall_status: 'partial',
        tracks: [{ track: 'creative', status: 'silent' }],
        summary: {
          tracks_passed: 0,
          tracks_failed: 0,
          tracks_silent: 1,
          tracks_partial: 0,
          total_steps: 6,
          steps_passed: 6,
          steps_failed: 0,
          steps_skipped: 0,
        },
      });
      assert.equal(result.passed, true);
      assert.equal(result.silentTracks, true);
    });

    it('returns passed=true with multiple silent tracks', () => {
      const result = evaluateGraderOutput({
        overall_status: 'partial',
        summary: { tracks_passed: 0, tracks_failed: 0, tracks_partial: 0, tracks_silent: 3, steps_failed: 0 },
      });
      assert.equal(result.passed, true);
      assert.equal(result.silentTracks, true);
    });

    it('returns passed=false when tracks_failed > 0', () => {
      const result = evaluateGraderOutput({
        overall_status: 'partial',
        summary: { tracks_passed: 1, tracks_failed: 1, tracks_partial: 0, tracks_silent: 0, steps_failed: 2 },
      });
      assert.equal(result.passed, false);
    });

    it('returns passed=false when tracks_partial > 0', () => {
      const result = evaluateGraderOutput({
        overall_status: 'partial',
        summary: { tracks_passed: 1, tracks_failed: 0, tracks_partial: 1, tracks_silent: 0, steps_failed: 0 },
      });
      assert.equal(result.passed, false);
    });

    it('returns passed=false when steps_failed > 0', () => {
      const result = evaluateGraderOutput({
        overall_status: 'partial',
        summary: { tracks_passed: 0, tracks_failed: 0, tracks_partial: 0, tracks_silent: 1, steps_failed: 1 },
      });
      assert.equal(result.passed, false);
    });

    it('returns passed=false when summary is absent', () => {
      // Guard: partial without summary must not pass (unknown state)
      const result = evaluateGraderOutput({ overall_status: 'partial' });
      assert.equal(result.passed, false);
    });
  });

  describe('overall_status: failing', () => {
    it('returns passed=false', () => {
      const result = evaluateGraderOutput({
        overall_status: 'failing',
        summary: { tracks_passed: 0, tracks_failed: 2, tracks_partial: 0, tracks_silent: 0, steps_failed: 4 },
      });
      assert.equal(result.passed, false);
    });
  });

  describe('no overall_status (pre-6.2 fallback)', () => {
    it('passes when tracks_failed=0 and steps_failed=0', () => {
      const result = evaluateGraderOutput({
        summary: { tracks_passed: 2, tracks_failed: 0, steps_failed: 0 },
      });
      assert.equal(result.passed, true);
    });

    it('fails when tracks_failed > 0', () => {
      const result = evaluateGraderOutput({
        summary: { tracks_passed: 1, tracks_failed: 1, steps_failed: 0 },
      });
      assert.equal(result.passed, false);
    });

    it('fails when steps_failed > 0', () => {
      const result = evaluateGraderOutput({
        summary: { tracks_passed: 0, tracks_failed: 0, steps_failed: 1 },
      });
      assert.equal(result.passed, false);
    });

    it('passes even when tracks_passed=0 if nothing failed (all-silent pre-6.2)', () => {
      // Regression guard: the old fallback branch required tracks_passed > 0,
      // which would fail all-silent runs. The new logic only checks for failures.
      const result = evaluateGraderOutput({
        summary: { tracks_passed: 0, tracks_failed: 0, steps_failed: 0 },
      });
      assert.equal(result.passed, true);
    });
  });

  describe('unparseable / empty input', () => {
    it('returns passed=false for empty object', () => {
      const result = evaluateGraderOutput({});
      assert.equal(result.passed, false);
    });
  });
});
