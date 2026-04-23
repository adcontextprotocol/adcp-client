/**
 * JSON-schema round-trip invariant for storyboard request builders.
 *
 * Companion to `request-builder-schema-roundtrip.test.js`. That suite validates
 * against generated Zod schemas, which do not enforce `format` keywords (e.g.
 * `format: "uri"`) and use `passthrough()` instead of `additionalProperties:
 * false`. This suite runs the same builder fallbacks through AJV against the
 * upstream JSON schemas so format violations and strict-additionalProperties
 * regressions surface as test failures.
 *
 * Walks every request JSON schema under `schemas/cache/latest/<domain>/*-request.json`,
 * builds the fallback for any task that has a matching request builder, and
 * asserts AJV validation succeeds. Issue #805 surfaced the bug class this
 * guards: builder fallbacks whose shape is Zod-valid but JSON-schema-invalid.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv').default;
const addFormats = require('ajv-formats').default;

const { buildRequest, hasRequestBuilder } = require('../../dist/lib/testing/storyboard/request-builder.js');
const { MUTATING_TASKS } = require('../../dist/lib/utils/idempotency.js');
const { ADCP_VERSION } = require('../../dist/lib/version.js');

const SCHEMA_ROOT = path.resolve(__dirname, '..', '..', 'schemas', 'cache', ADCP_VERSION);

// Tasks whose schema requires idempotency_key but which aren't in
// MUTATING_TASKS because they ship as webhooks, not MCP tools (so the Zod
// schema lives outside TOOL_REQUEST_SCHEMAS). The runner still injects on
// these; mirror that here.
const EXTRA_MUTATING = new Set(['creative_approval', 'update_rights']);

// Builders whose fallback is known to fail JSON-schema validation today.
// Kept as an explicit allowlist so this invariant stays useful the moment a
// future fallback drifts out of spec — add it here with a reason, fix it,
// then remove the entry. Empty today; the guard tests below still run so any
// newly-documented-and-then-fixed entry would surface via the "still-fail"
// guard.
const KNOWN_NONCONFORMING = new Map([]);

const SYNTHETIC_IDEMPOTENCY_KEY = 'roundtrip_test_key_0000000000';

const DEFAULT_OPTIONS = {
  brand: { domain: 'acmeoutdoor.example' },
  account: { brand: { domain: 'acmeoutdoor.example' }, operator: 'acmeoutdoor.example' },
};

function isMutating(task) {
  return MUTATING_TASKS.has(task) || EXTRA_MUTATING.has(task);
}

function step(task) {
  return { id: `test-${task}`, title: `Test ${task}`, task };
}

function walkJsonFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsonFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

function loadAjv() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  // Pre-register every schema so $ref resolution works regardless of lookup
  // order. Skip duplicates silently — some schemas are reachable via both the
  // flat per-domain tree and the bundled tree.
  for (const file of walkJsonFiles(SCHEMA_ROOT)) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      continue;
    }
    const id = raw.$id;
    if (typeof id === 'string' && !ajv.getSchema(id)) {
      ajv.addSchema(raw);
    }
  }
  return ajv;
}

function collectRequestSchemas() {
  // Walk the flat per-domain tree rather than `bundled/` so domains like
  // `governance/` and `brand/` (which ship their schemas outside the bundled
  // tree) are covered.
  const out = [];
  for (const entry of fs.readdirSync(SCHEMA_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'bundled' || entry.name === 'core') continue;
    const domainDir = path.join(SCHEMA_ROOT, entry.name);
    for (const file of walkJsonFiles(domainDir)) {
      const base = path.basename(file, '.json');
      if (!base.endsWith('-request')) continue;
      const task = base.slice(0, -'-request'.length).replace(/-/g, '_');
      out.push({ task, file });
    }
  }
  return out;
}

function formatAjvErrors(errors) {
  return (errors ?? [])
    .slice(0, 5)
    .map(e => `  path=${e.instancePath || '(root)'} keyword=${e.keyword} msg=${e.message}`)
    .join('\n');
}

describe('Request builder JSON-schema round-trip', () => {
  const ajv = loadAjv();
  const pairs = collectRequestSchemas().filter(({ task }) => hasRequestBuilder(task));

  for (const { task, file } of pairs) {
    if (KNOWN_NONCONFORMING.has(task)) continue;

    test(`${task} fallback round-trips through JSON schema`, () => {
      const schema = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const validate = (typeof schema.$id === 'string' && ajv.getSchema(schema.$id)) || ajv.compile(schema);

      const request = buildRequest(step(task), {}, DEFAULT_OPTIONS);

      // Mirror the runner: inject an idempotency_key on mutating tasks when
      // the builder didn't mint one. Non-mutating tasks (e.g. check_governance)
      // must NOT receive one — the schema's `additionalProperties: false`
      // would reject it, and that would be a genuine test failure.
      if (isMutating(task) && request.idempotency_key === undefined) {
        request.idempotency_key = SYNTHETIC_IDEMPOTENCY_KEY;
      }

      const ok = validate(request);
      assert.ok(
        ok,
        ok
          ? ''
          : `${task} fallback fails JSON-schema validation:\n${formatAjvErrors(validate.errors)}\nrequest=${JSON.stringify(request, null, 2)}`
      );
    });
  }

  test('KNOWN_NONCONFORMING entries still reference real builders (stale-allowlist guard)', () => {
    const covered = new Set(pairs.map(p => p.task));
    const stale = [...KNOWN_NONCONFORMING.keys()].filter(t => !covered.has(t));
    assert.deepStrictEqual(
      stale,
      [],
      `KNOWN_NONCONFORMING lists task(s) with no matching builder+schema pair — delete these entries: ${stale.join(', ')}`
    );
  });

  test('KNOWN_NONCONFORMING entries still fail (remove any that now pass)', () => {
    const stillPassing = [];
    for (const [task, reason] of KNOWN_NONCONFORMING) {
      const match = pairs.find(p => p.task === task);
      if (!match) continue;
      const schema = JSON.parse(fs.readFileSync(match.file, 'utf-8'));
      const validate = (typeof schema.$id === 'string' && ajv.getSchema(schema.$id)) || ajv.compile(schema);
      const request = buildRequest(step(task), {}, DEFAULT_OPTIONS);
      if (isMutating(task) && request.idempotency_key === undefined) {
        request.idempotency_key = SYNTHETIC_IDEMPOTENCY_KEY;
      }
      if (validate(request)) stillPassing.push(`${task} (was: ${reason})`);
    }
    assert.deepStrictEqual(
      stillPassing,
      [],
      `Builder(s) now PASS JSON-schema validation — remove from KNOWN_NONCONFORMING:\n  ${stillPassing.join('\n  ')}`
    );
  });
});
