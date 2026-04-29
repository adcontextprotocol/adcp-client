# AAO Verified (Live) Compliance Engine — Design

**Status**: Draft / RFC
**Audience**: `@adcp/client` maintainers, AAO platform team, sellers planning to enroll
**Implements**: AdCP `docs/building/aao-verified.mdx`, eight observability checks
**Last updated**: 2026-04-29

## 1. Overview

The AAO Verified (Live) qualifier attests that real production traffic flows through a seller's AdCP agent — not just that storyboards pass. AAO issues the qualifier by running a continuous observability engine against a designated **compliance account** in the seller's tenant over a 7–14 day rolling window, evaluating eight observable checks. The qualifier auto-expires when signal degrades.

This document specifies the engine's architecture so it can:

- Ship as a **library** in `@adcp/client` (sub-export: `@adcp/client/verified-engine`) so any seller can self-test against their own endpoint.
- Be deployed as a **service** by AAO for public-badge issuance against enrolled sellers.

Both use the same library; AAO's deployment is one consumer among many.

### What the engine is

A long-running orchestrator that:

1. Polls a seller's AdCP agent on a schedule (typically once per hour, configurable).
2. Captures snapshots of the eight check inputs.
3. Maintains a rolling-window state per `(agent_id, account_id, role)` tuple.
4. Evaluates check pass/fail at each tick; updates badge state.
5. Emits a signed attestation when badge state changes.

### What the engine is not

- **Not a storyboard runner.** Storyboards remain the (Spec) qualifier surface — synchronous, fixture-driven, one-shot. The engine is asynchronous, real-data-driven, continuous.
- **Not a scheduler of campaigns.** It does not trigger campaigns, attach creatives, or run lifecycle. That's [#3561](https://github.com/adcontextprotocol/adcp/issues/3561) (`attestation_runner`) and [#3046](https://github.com/adcontextprotocol/adcp/issues/3046) (canonical-campaign runner). The engine in this document only **observes**.
- **Not a buyer-side test rig.** The seller (or AAO operating on behalf of the seller) runs the engine; buyers consume the resulting badge artifact.

## 2. Goals and non-goals

### Goals

- **Library-first**: usable embedded in any Node process, not bound to a hosted service.
- **Zero ground-truth dependency**: all eight checks evaluable from AdCP responses alone; no admin-API access, no exported reports.
- **Pluggable persistence**: works against `MemoryStorage` (tests/dev) and `PostgresStateStore` (production).
- **Pluggable clock**: real-time scheduler in production, virtual-time stepper in tests.
- **Pluggable signer**: same `SignerProvider` abstraction that webhook/request signing uses.
- **Recoverable**: crash anywhere mid-window without losing observation history; resume from store.
- **Anti-teach-to-test by construction**: probe cadence and slice selection are seller-opaque; engine MAY operate from secondary identities to detect identity-keyed branching.

### Non-goals (v1)

- Hard ground-truth reconciliation against the seller's ad-server dashboard.
- Buyer-attestation upload flows.
- Canonical-campaign trafficking (`attestation_runner` scope).
- Automatic remediation of failing checks.
- Multi-tenant operator UI (a separate service surface in AAO infra).

## 3. Architectural relationship to existing code

The engine reuses primitives already in `@adcp/client`:

| Need | Existing primitive | Where |
|---|---|---|
| AdCP task dispatch | `SingleAgentClient`, `ADCPMultiAgentClient` | `src/lib/core/` |
| Auth (OAuth, bearer) | `src/lib/auth/` | shared |
| Storage abstraction | `Storage<T>` interface | `src/lib/storage/` |
| Domain state | `AdcpStateStore` collection model | `src/lib/server/state-store.ts` |
| JWT signing | `SignerProvider`, `pemToAdcpJwk` | `src/lib/signing/` |
| Test fixture seeding | `comply_test_controller`, `compliance-fixtures/` | `src/lib/server/test-controller.ts` |

The engine adds:

- A long-running orchestrator (`Orchestrator`) that schedules ticks.
- A `Check` interface and registry of the eight checks.
- New `AdcpStateStore` collections for observations, deltas, and badge state.
- An attestation builder that emits signed JWT artifacts.
- A `Clock` abstraction for real-time vs. virtual-time scheduling.

## 4. State model

### 4.1 Identity tuple

Every observation series is keyed by:

```ts
type EngineSubject = {
  agent_id: string;       // The seller's AdCP agent ID being observed
  account_id: string;     // The compliance account inside that agent's tenant
  role: AgentRole;        // 'sales' | 'signals' | 'governance' | ... (3.x: 'sales' only)
};
```

The engine MAY observe multiple subjects in parallel from a single deployment. Each subject has its own state, schedule, and badge.

### 4.2 ObservationSnapshot

A single tick captures:

```ts
type ObservationSnapshot = {
  subject_key: string;                    // hash of (agent_id, account_id, role)
  observed_at: ISO8601;
  source_tick: number;                    // monotonic, restarts at engine identity boundary
  active_buys: MediaBuySnapshot[];        // get_media_buys result, normalized
  authorization_envelope: Authorization;  // from list_accounts({account: ...})
  reporting_surfaces_observed: SurfaceObservation[]; // webhook | poll | bucket
  raw_responses: RawResponseSet;          // for replay/audit, optional retention
  errors: ObservationError[];             // any AdCP errors hit during this tick
};
```

`MediaBuySnapshot` flattens the relevant fields per buy (status, valid_actions, history tail, by_package totals, daily delivery for the snapshot's window). The denormalized shape is what the checks operate on.

### 4.3 RollingWindow

A subject's window is a deque of snapshots:

```ts
type RollingWindow = {
  subject_key: string;
  window_open: ISO8601;          // oldest snapshot's observed_at
  window_close: ISO8601;         // most recent snapshot's observed_at
  target_duration_days: number;  // 7..14
  snapshots: ObservationSnapshot[];
  maintenance_windows: MaintenanceDeclaration[]; // seller-declared quiet periods
};
```

The window slides forward by trimming snapshots older than `target_duration_days` (minus declared maintenance time within that span).

### 4.4 BadgeState (state machine)

```
                            ┌─────────────┐
                            │  Inactive   │ ── enroll ──▶ Pending (warming)
                            └─────────────┘                  │
                                                             │ window full + all checks pass
                                                             ▼
   Lapsed ◀── any required check fails ──── Active ◀────── Pending
     │                                          │
     │                                          │ seller declares quiet period
     │                                          ▼
     │                                Quiet-Period-Declared
     │                                          │
     │                                          │ quiet ends
     │                                          ▼
     └──────── re-enroll ──── Pending ◀─── Active
```

States:

- **Inactive**: no enrollment.
- **Pending**: enrolled, window not yet full or first checks not yet evaluated.
- **Active**: badge holds. All checks have passed across the rolling window.
- **Quiet-Period-Declared**: seller declared a maintenance window; liveness check is suppressed for the declared duration. Other checks remain in force.
- **Lapsed**: a required check failed within the window. Badge expired. Re-enrollment moves to Pending.

Transitions are persisted; every transition emits a signed attestation diff (see §7).

## 5. Check interface

Each check is a pure function over the rolling window plus the latest snapshot:

```ts
interface Check {
  id: CheckId; // 'liveness' | 'freshness' | 'plausibility' | ...
  required_for_active: boolean;       // all v1 checks: true
  evaluate(window: RollingWindow, latest: ObservationSnapshot): CheckResult;
  // Probe metadata — declares what the check needs, so the orchestrator
  // can elide AdCP calls when no check on the schedule needs the data.
  probes(): ProbeRequirement[];
}

type CheckResult = {
  check_id: CheckId;
  status: 'pass' | 'fail' | 'inconclusive' | 'skipped';
  reason?: string;                    // human-readable, structured `code` preferred
  code?: CheckFailureCode;            // 'NO_ACTIVE_BUY' | 'STALE_DELIVERY' | ...
  evidence?: Evidence;                // pointer into the snapshot for debugging
};
```

Checks are pure — they MUST NOT touch the network. The orchestrator owns probing; checks consume snapshot data.

`inconclusive` differs from `fail`: it means the engine couldn't gather enough data to decide (e.g., the window hasn't filled yet, or the seller hasn't declared whether a reporting surface exists). Inconclusive checks block badge issuance but do not lapse an existing badge.

## 6. The eight checks

Each section lists: trigger, AdCP surface, evaluation rule, failure codes, edge cases.

### 6.1 Liveness

**Triggers**: every tick.
**AdCP surface**: `get_media_buys({status_filter: 'active'})` plus filter for non-canceled.
**Evaluation**: there exists at least one media buy with `status === 'active'` for ≥ 80% of the rolling window, adjusting for declared maintenance.
**Failure codes**: `NO_ACTIVE_BUY_IN_WINDOW`, `INSUFFICIENT_ACTIVE_COVERAGE`.
**Edge cases**: a single ultra-short flight that ends before the next tick → the snapshot captures it; window-coverage math accounts for it.

### 6.2 Freshness

**Triggers**: every tick.
**AdCP surface**: `get_media_buy_delivery({media_buy_id, start_date: D, end_date: D})` for D = today, on consecutive ticks.
**Evaluation**: for at least one active media buy, two consecutive ticks ≥ 1h apart return different `impressions` (or `spend`, currency-aware).
**Failure codes**: `STALE_DELIVERY`, `ZERO_GROWTH_OVER_24H`.
**Edge cases**: campaigns at end of flight may legitimately stop incrementing; freshness is required of *at least one* active buy with `flight_remaining > 0`.

### 6.3 Plausibility

**Triggers**: every tick.
**AdCP surface**: `get_media_buy_delivery` plus the prior tick's response for monotonicity.
**Evaluation**:
- `impressions` non-decreasing across the day (within the same `start_date`/`end_date` window) for active buys.
- Per-buy total impressions = sum of `by_package[].impressions` (within rounding tolerance of 1 imp).
- `pacing_index` ∈ [0, 5] for active buys (pacing > 5x is implausible).
- Non-zero metrics where the buy is active and has been live > 6h.

**Failure codes**: `IMPRESSIONS_DECREASED`, `BY_PACKAGE_SUM_MISMATCH`, `IMPLAUSIBLE_PACING`, `ZERO_AFTER_WARMUP`.

### 6.4 Filter correctness

**Triggers**: once per day, randomized window.
**AdCP surface**: two `get_media_buy_delivery` calls back-to-back with different `(start_date, end_date)` ranges on the same buy.
**Evaluation**: `reporting_period.start` reflects the input dates; the two calls return different metrics when the underlying data differs.
**Failure codes**: `FILTER_NO_OP`, `REPORTING_PERIOD_MISMATCH`.
**Edge cases**: flights that haven't yet had impressions in the queried window may legitimately return zero for both — use a buy with confirmed delivery on day N to calibrate.

### 6.5 Reporting-surface cross-consistency

**Triggers**: only when seller declares > 1 reporting surface in `reporting_capabilities` (`webhook`, `polling`, `offline`).
**AdCP surface**: webhook receiver (engine spins up its own endpoint and uses `attestation_verifier` scope to attach), `get_media_buy_delivery`, and the seller's offline bucket if declared.
**Evaluation**: for the same `(media_buy_id, window)`, all declared surfaces report the same impressions/spend within the seller's declared `finalization_tolerance` (default 5%, max 24h).
**Failure codes**: `WEBHOOK_POLL_DIVERGENCE`, `BUCKET_POLL_DIVERGENCE`, `WEBHOOK_NEVER_FIRED`.
**Edge cases**: webhook attach requires `attestation_verifier`; if scope is missing, check is skipped (not failed).

### 6.6 Lifecycle correctness

**Triggers**: on every observed status transition.
**AdCP surface**: `get_media_buys` history; `get_media_buy_delivery` post-transition.
**Evaluation**:
- `status === 'completed'`: post-transition delivery snapshots stop incrementing.
- `status === 'paused'`: same.
- `status === 'canceled'`: same; `cancellation` block populated; `valid_actions` reflects terminal state.
- `history` entries are append-only (revision monotonic).

**Failure codes**: `COMPLETED_BUT_DELIVERING`, `PAUSED_BUT_DELIVERING`, `CANCELED_INCOMPLETE`, `HISTORY_REWRITE`.

### 6.7 Introspection consistency

**Triggers**: at least once per window, plus on every observed scope change.
**AdCP surface**: `list_accounts({account: compliance_account})` to read `authorization` envelope; sample tasks to verify enforcement matches advertisement.
**Evaluation**:
- Tasks NOT in `allowed_tasks` MUST return `SCOPE_INSUFFICIENT` when invoked.
- Fields outside `field_scopes` MUST return `FIELD_NOT_PERMITTED`.
- Sequential reads within 300s return identical envelopes (per [#2964](https://github.com/adcontextprotocol/adcp/issues/2964) consistency normative).
- Operator-initiated changes propagate within 300s.

**Failure codes**: `SCOPE_ADVERTISED_NOT_ENFORCED`, `FIELD_ADVERTISED_NOT_ENFORCED`, `ENVELOPE_FLICKER`, `OPERATOR_CHANGE_LATENT`.

### 6.8 Seller-initiated state transition propagation

**Triggers**: every tick (passive), plus on cross-validation events.
**AdCP surface**: `get_media_buys` with `include_history` enabled.
**Evaluation**: out-of-band state changes (trafficker pauses in ad-server UI, finance cancels for non-payment, flight ends) MUST surface in `status`, `valid_actions`, and `history` within seller's declared status-freshness tolerance (default 1h, max 24h).
**Failure codes**: `STATUS_NOT_PROPAGATED`, `HISTORY_NOT_UPDATED`, `VALID_ACTIONS_STALE`.
**Edge cases**: if no out-of-band transitions occur during a window, this check returns `inconclusive` rather than `pass` — sellers without ad-ops activity in the test account need to manually trigger one for badge issuance.

## 7. Storage schema

The engine adds three new collections to `AdcpStateStore`:

### `verified:observations`

Key: `{subject_key}:{tick_iso}`
Value: `ObservationSnapshot`
Retention: 90 days (configurable). Older snapshots compacted into deltas.

### `verified:badge_state`

Key: `{subject_key}`
Value: `BadgeStateRecord` — current state + last transition.
Retention: indefinite.

### `verified:attestations`

Key: `{subject_key}:{attestation_id}`
Value: signed JWT + payload (for replay/audit).
Retention: indefinite (these are public artifacts).

The orchestrator and checks read/write through `AdcpStateStore`'s typed accessors; existing implementations (Memory, Postgres) work without modification.

## 8. Attestation output

When badge state transitions (Pending → Active, Active → Lapsed, etc.), the engine emits a signed JWT:

```jsonc
{
  "iss": "https://aao.example.com",          // engine identity
  "sub": "agent:<agent_id>:account:<account_id>:role:sales",
  "iat": 1746058832,
  "exp": 1746663632,                          // 7 days from issuance
  "verification_modes": ["live"],             // matches PR #2153 badge schema
  "subject_key": "<hashed tuple>",
  "observation_window": { "start": "...", "end": "..." },
  "checks": [
    { "id": "liveness", "status": "pass", "evidence_ref": "obs:..." }
  ],
  "previous_attestation": "<prior jti, if any>",
  "transition": "PENDING_TO_ACTIVE"
}
```

Signing uses the existing `SignerProvider` abstraction — KMS-backed in production, file-keyed in dev. Attestations are publishable as-is to the badge endpoint; AAO consumes them for the public registry.

## 9. Orchestrator

```ts
class Orchestrator {
  constructor(opts: {
    clients: Map<string, SingleAgentClient>;  // one per subject
    store: AdcpStateStore;
    signer: SignerProvider;
    clock: Clock;                              // real or virtual
    schedule: Schedule;                        // tick cadence per subject
    checks: Check[];                           // registry, default = all 8
  });

  async tick(subject: EngineSubject): Promise<TickResult>;
  async run(): Promise<never>;                 // long-running loop
  async shutdown(): Promise<void>;
}
```

A tick:

1. Compute probe requirements from `checks.flatMap(c => c.probes())` — deduplicate.
2. Issue AdCP calls in parallel; capture `ObservationSnapshot`.
3. Append to rolling window; trim if past target duration.
4. Run each check; collect `CheckResult[]`.
5. Compute new badge state; transition if needed.
6. Persist snapshot + state.
7. If transition, build + sign attestation, persist, emit hook (`onAttestation`).

Probe deduplication is essential: liveness, freshness, plausibility, and lifecycle all touch `get_media_buys` / `get_media_buy_delivery`. Without dedup, each tick would issue 4× the necessary calls.

## 10. Clock abstraction

```ts
interface Clock {
  now(): Date;
  sleepUntil(when: Date): Promise<void>;
  setTimeout(handler: () => void, ms: number): void; // returns cancel handle
}
```

Two implementations:

- `SystemClock`: real-time. Production default.
- `VirtualClock`: test-time. Advances on `tick(amountMs)`. Tests can simulate a 14-day window in seconds.

The orchestrator and its scheduler use the `Clock` exclusively; no direct `Date.now()` or `setTimeout`.

## 11. Test rig

Driving synthetic 7-day cycles in dev requires:

1. A test agent: spin up via `createAdcpServer()` with seeded `compliance-fixtures/`.
2. `comply_test_controller` to force campaign states (active → paused → completed → canceled) on whatever schedule the test wants.
3. `VirtualClock` to advance time without real-time waits.
4. Optional: a fault injector that overrides specific responses to verify each check's failure path.

A reference test:

```ts
test('badge transitions Pending to Active after window fills with all checks passing', async () => {
  const clock = new VirtualClock();
  const agent = await spinUpTestAgent({ fixtures: 'compliance' });
  const orchestrator = new Orchestrator({
    clients: new Map([[agent.id, agent.client]]),
    store: new MemoryStore(),
    signer: new TestSigner(),
    clock,
    schedule: { defaultIntervalMs: 60 * 60 * 1000 },
    checks: ALL_CHECKS,
  });

  await orchestrator.enroll({ agent_id: agent.id, account_id: 'compliance' });
  await advance(clock, orchestrator, days: 8);

  const state = await orchestrator.store.getBadgeState(subject);
  expect(state.state).toBe('Active');
  expect(state.attestations).toHaveLength(1);
});
```

A fault-injection test pattern per check:

```ts
test('check freshness fails when delivery numbers stop changing', async () => {
  agent.testController.freezeDeliveryAt(day: 3);
  await advance(clock, orchestrator, days: 8);
  expect(state.state).toBe('Lapsed');
  expect(latestAttestation.checks.find(c => c.id === 'freshness').status).toBe('fail');
});
```

## 12. Implementation phases

| Phase | Scope | Estimated effort |
|---|---|---|
| 0 — design (this doc) | Architecture, state model, check interface, output shape, review | 1–2 days |
| 1 — foundation | Skeleton: `Orchestrator`, `Clock`, `BadgeState` machine, store collections, no checks | 3–5 days |
| 2 — checks 1–6 | Liveness, freshness, plausibility, filter correctness, surface cross-consistency, lifecycle | 1–2 weeks |
| 3 — checks 7–8 | Introspection consistency, state transition propagation | 3–5 days |
| 4 — attestation | JWT signing, transition emission, public badge endpoint shape | 3–5 days |
| 5 — AAO hosting | Service deployment, identity/key mgmt, registry integration | AAO infra side, separate scope |

Phases 1–4 are this library's responsibility. Phase 5 lives in AAO infra (server/, separate repo).

## 13. Open questions for review

1. **Probe cadence default**. 1h tick (= 168 ticks per 7-day window) is the working default. Cheaper-end argument: 4h tick (42 per window) saves cost; harder to detect freshness regressions.
2. **Multiple subjects per orchestrator**. Should one engine instance handle many sellers, or is one-per-seller cleaner? Implications for state-store sharding and identity-keying for anti-branching probes.
3. **Secondary-identity probes**. Spec mentions AAO MAY operate from secondary identities to detect identity-keyed branching. Where does that live — engine-internal (multi-identity orchestrator) or operator-side (run two engines, diff results)?
4. **Maintenance-window declaration mechanism**. Today the spec says sellers declare on the compliance account itself. Where in `sync_accounts` / `list_accounts` does this go? Is a new field needed, or does `comply_test_controller` extend?
5. **Failure thresholds for noisy signals**. Should checks have configurable tolerance, or is binary pass/fail enough? E.g., one bad freshness sample in a 168-sample window — pass or fail?
6. **Persistence of raw responses**. `ObservationSnapshot.raw_responses` for replay/audit could grow large. Configurable retention or always-on with compaction?
7. **Observability of the engine itself**. Metrics, logs, traces — emit through OpenTelemetry, integrate with `observability/` module?
8. **Sub-export naming**. `@adcp/client/verified-engine` or `@adcp/client/observability/verified` or sibling `@adcp/verified-engine` package?

## 14. Out of scope

Listed for clarity:

- Hard ground-truth reconciliation against ad-server admin reports.
- Buyer-attestation upload as evidence.
- `attestation_runner` scope ([#3561](https://github.com/adcontextprotocol/adcp/issues/3561)) — write-side counterpart, future RFC.
- Canonical-campaign trafficking ([#3046](https://github.com/adcontextprotocol/adcp/issues/3046)) — engine doesn't run campaigns.
- AAO public registry / badge endpoint — separate AAO-infra concern, this library only emits artifacts.
- Per-protocol generalization beyond `sales` role — signals/governance/creative engines specced separately when their (Live) flows land.

## 15. References

- AdCP spec: [`docs/building/aao-verified.mdx`](https://github.com/adcontextprotocol/adcp/blob/main/docs/building/aao-verified.mdx) — eight-check definitions, badge lifecycle, enrollment.
- AdCP issue: [#2965](https://github.com/adcontextprotocol/adcp/issues/2965) — AAO Verified (Live) overview.
- AdCP issue: [#2964](https://github.com/adcontextprotocol/adcp/issues/2964) — `attestation_verifier` scope (merged in 3.1.0-beta).
- AdCP issue: [#3561](https://github.com/adcontextprotocol/adcp/issues/3561) — `attestation_runner` (future scope).
- AdCP issue: [#3046](https://github.com/adcontextprotocol/adcp/issues/3046) — canonical-campaign runner RFC.
- `@adcp/client` modules: `src/lib/testing/storyboard/` (Tier-1 runner), `src/lib/storage/`, `src/lib/server/state-store.ts`, `src/lib/signing/`, `src/lib/server/test-controller.ts`.
