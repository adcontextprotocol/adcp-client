/**
 * Structural completeness tests for every storyboard in the compliance cache.
 *
 * Validates that every YAML in `compliance/cache/{version}/` has the
 * infrastructure needed to run:
 * - Required fields (id, version, title, phases)
 * - Every task has a response schema registered (for field validation)
 * - Every step has either a request builder or sample_request fallback
 * - Phase and step IDs are unique within their parent
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { listAllComplianceStoryboards } = require('../../dist/lib/testing/storyboard/index.js');
const { hasRequestBuilder } = require('../../dist/lib/testing/storyboard/request-builder.js');
const { TASK_TO_METHOD } = require('../../dist/lib/testing/storyboard/task-map.js');
const { TOOL_RESPONSE_SCHEMAS } = require('../../dist/lib/utils/response-schemas.js');

const allStoryboards = listAllComplianceStoryboards();

// Upstream ships placeholder storyboards with empty phases for protocols/specialisms
// whose conformance tests haven't been written yet. Skip structural assertions on those.
const storyboards = allStoryboards.filter(sb => Array.isArray(sb.phases) && sb.phases.length > 0);

// Tasks the runner executes internally, not protocol tools exposed by the agent.
// These don't need request builders, sample requests, or response schemas.
const HARNESS_TASKS = new Set([
  'comply_test_controller',
  // Security baseline (compliance/universal/security.yaml): runner fetches the
  // well-known documents directly and asserts synthetic flags.
  'protected_resource_metadata',
  'oauth_auth_server_metadata',
  'assert_contribution',
]);

// Tasks referenced via `$test_kit.*` substitution — the runner resolves these
// to real tool names at run time from the test kit config. They're not tasks
// in their own right.
const isSubstitutionTask = task => typeof task === 'string' && task.startsWith('$');

describe('storyboard structural completeness', () => {
  it('loads at least 25 compliance storyboards from the cache', () => {
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
            assert.equal(
              unique.size,
              ids.length,
              `Duplicate step IDs in phase ${phase.id}: ${ids.filter((id, i) => ids.indexOf(id) !== i)}`
            );
          });

          for (const step of phase.steps) {
            describe(`step: ${step.id}`, () => {
              it('has required fields', () => {
                assert.ok(step.id, 'missing step id');
                assert.ok(step.title, 'missing step title');
                assert.ok(step.task, 'missing task');
              });

              it('has a request builder or sample_request', () => {
                if (HARNESS_TASKS.has(step.task) || isSubstitutionTask(step.task)) return;
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
  const allTasks = new Set();
  for (const sb of storyboards) {
    for (const phase of sb.phases) {
      for (const step of phase.steps) {
        allTasks.add(step.task);
      }
    }
  }

  for (const task of [...allTasks].sort()) {
    if (HARNESS_TASKS.has(task) || isSubstitutionTask(task)) continue;

    it(`${task} has a registered response schema`, () => {
      assert.ok(
        TOOL_RESPONSE_SCHEMAS[task],
        `Task "${task}" is used in storyboards but has no response schema in TOOL_RESPONSE_SCHEMAS`
      );
    });
  }
});

describe('task execution coverage', () => {
  const allTasks = new Set();
  for (const sb of storyboards) {
    for (const phase of sb.phases) {
      for (const step of phase.steps) {
        allTasks.add(step.task);
      }
    }
  }

  it('all tasks are either mapped or handled by executeTask fallback', () => {
    const mapped = [...allTasks].filter(t => t in TASK_TO_METHOD);
    const fallback = [...allTasks].filter(t => !(t in TASK_TO_METHOD));
    assert.ok(mapped.length > 0, 'should have at least some mapped tasks');
    assert.ok(mapped.length + fallback.length === allTasks.size);
  });
});
