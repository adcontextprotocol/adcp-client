/**
 * Structural completeness tests for all bundled storyboards.
 *
 * Validates that every storyboard has the infrastructure needed to run:
 * - Required YAML fields (id, version, title, track, phases)
 * - Every task has a response schema registered (for field validation)
 * - Every step has either a request builder or sample_request fallback
 * - Every storyboard with a track is assigned to at least one platform_type
 * - Phase and step IDs are unique within their parent
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { loadBundledStoryboards } = require('../../dist/lib/testing/storyboard/loader.js');
const { hasRequestBuilder } = require('../../dist/lib/testing/storyboard/request-builder.js');
const { TASK_TO_METHOD } = require('../../dist/lib/testing/storyboard/task-map.js');
const { TOOL_RESPONSE_SCHEMAS } = require('../../dist/lib/utils/response-schemas.js');
const {
  PLATFORM_STORYBOARDS,
} = require('../../dist/lib/testing/compliance/platform-storyboards.js');

const storyboards = loadBundledStoryboards();

// Tasks that are part of the test harness — not protocol tools
const HARNESS_TASKS = new Set(['comply_test_controller']);

describe('storyboard structural completeness', () => {
  it('loads at least 25 bundled storyboards', () => {
    assert.ok(storyboards.length >= 25, `Expected ≥25 storyboards, got ${storyboards.length}`);
  });

  for (const sb of storyboards) {
    describe(`storyboard: ${sb.id}`, () => {
      it('has required top-level fields', () => {
        assert.ok(sb.id, 'missing id');
        assert.ok(sb.version, 'missing version');
        assert.ok(sb.title, 'missing title');
        assert.ok(sb.narrative, 'missing narrative');
        assert.ok(Array.isArray(sb.phases), 'phases must be an array');
        assert.ok(sb.phases.length > 0, 'must have at least one phase');
      });

      it('has unique phase IDs', () => {
        const ids = sb.phases.map(p => p.id);
        const unique = new Set(ids);
        assert.equal(unique.size, ids.length, `Duplicate phase IDs: ${ids.filter((id, i) => ids.indexOf(id) !== i)}`);
      });

      for (const phase of sb.phases) {
        describe(`phase: ${phase.id}`, () => {
          it('has required fields', () => {
            assert.ok(phase.id, 'missing phase id');
            assert.ok(phase.title, 'missing phase title');
            assert.ok(Array.isArray(phase.steps), 'steps must be an array');
            assert.ok(phase.steps.length > 0, 'must have at least one step');
          });

          it('has unique step IDs', () => {
            const ids = phase.steps.map(s => s.id);
            const unique = new Set(ids);
            assert.equal(unique.size, ids.length, `Duplicate step IDs in phase ${phase.id}: ${ids.filter((id, i) => ids.indexOf(id) !== i)}`);
          });

          for (const step of phase.steps) {
            describe(`step: ${step.id}`, () => {
              it('has required fields', () => {
                assert.ok(step.id, 'missing step id');
                assert.ok(step.title, 'missing step title');
                assert.ok(step.task, 'missing task');
              });

              it('has a request builder or sample_request', () => {
                const hasBuilder = hasRequestBuilder(step.task);
                const hasSample = step.sample_request !== undefined && step.sample_request !== null;
                assert.ok(
                  hasBuilder || hasSample,
                  `Step ${sb.id}/${step.id} (task: ${step.task}) has no request builder and no sample_request`
                );
              });
            });
          }
        });
      }
    });
  }
});

describe('response schema coverage', () => {
  // Collect all unique tasks across all storyboards
  const allTasks = new Set();
  for (const sb of storyboards) {
    for (const phase of sb.phases) {
      for (const step of phase.steps) {
        allTasks.add(step.task);
      }
    }
  }

  for (const task of [...allTasks].sort()) {
    if (HARNESS_TASKS.has(task)) continue;

    it(`${task} has a registered response schema`, () => {
      assert.ok(
        TOOL_RESPONSE_SCHEMAS[task],
        `Task "${task}" is used in storyboards but has no response schema in TOOL_RESPONSE_SCHEMAS`
      );
    });
  }
});

describe('task execution coverage', () => {
  // Every task should either have a TASK_TO_METHOD entry or fall through to executeTask()
  // This test documents which tasks use the fallback path
  const allTasks = new Set();
  for (const sb of storyboards) {
    for (const phase of sb.phases) {
      for (const step of phase.steps) {
        allTasks.add(step.task);
      }
    }
  }

  it('all tasks are either mapped or handled by executeTask fallback', () => {
    // executeTask() handles any task name, so this always passes.
    // The test documents which tasks use the typed path vs fallback.
    const mapped = [...allTasks].filter(t => t in TASK_TO_METHOD);
    const fallback = [...allTasks].filter(t => !(t in TASK_TO_METHOD));
    assert.ok(mapped.length > 0, 'should have at least some mapped tasks');
    // fallback tasks are fine — they use client.executeTask()
    // This test just ensures we're aware of the split
    assert.ok(mapped.length + fallback.length === allTasks.size);
  });
});

describe('platform storyboard assignment', () => {
  // Storyboards with a platform_types YAML field should appear in those
  // platform type entries in PLATFORM_STORYBOARDS. Universal storyboards
  // (no platform_types) are auto-included by resolveStoryboards() at runtime
  // based on required_tools, so they don't need explicit mapping.

  const allPlatformStoryboardIds = new Set();
  for (const ids of Object.values(PLATFORM_STORYBOARDS)) {
    for (const id of ids) {
      allPlatformStoryboardIds.add(id);
    }
  }

  it('all PLATFORM_STORYBOARDS entries resolve to bundled storyboards', () => {
    const bundledIds = new Set(storyboards.map(sb => sb.id));
    for (const [type, ids] of Object.entries(PLATFORM_STORYBOARDS)) {
      for (const id of ids) {
        assert.ok(bundledIds.has(id), `${id} in PLATFORM_STORYBOARDS[${type}] not found in bundled storyboards`);
      }
    }
  });

  for (const sb of storyboards) {
    if (!sb.platform_types?.length) continue; // universal storyboards skip this check

    for (const platformType of sb.platform_types) {
      it(`${sb.id} appears in PLATFORM_STORYBOARDS[${platformType}]`, () => {
        const ids = PLATFORM_STORYBOARDS[platformType];
        assert.ok(
          ids && ids.includes(sb.id),
          `Storyboard "${sb.id}" declares platform_type "${platformType}" but is not in PLATFORM_STORYBOARDS[${platformType}]`
        );
      });
    }
  }
});

describe('storyboard track field coverage', () => {
  // Known storyboards that intentionally lack a track field
  const TRACKLESS_ALLOWED = new Set(['creative_generative']);

  for (const sb of storyboards) {
    if (TRACKLESS_ALLOWED.has(sb.id)) continue;

    it(`${sb.id} has a track field`, () => {
      assert.ok(sb.track, `Storyboard "${sb.id}" is missing a track field`);
    });
  }
});
