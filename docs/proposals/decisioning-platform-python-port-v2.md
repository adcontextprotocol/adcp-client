# RFC: Python port of DecisioningPlatform (v6.0) — v2

## Status

**Proposed** — open for review by the AdCP Python team and the salesagent team.

This RFC supersedes [`decisioning-platform-python-port.md`](./decisioning-platform-python-port.md) (v1). v1 was written before the round-2 hybrid-seller pivot and the round-3 `AdcpError` raise-path refactor; large parts of its surface (`AsyncOutcome[T]` discriminated union, `*Task` dual methods) are no longer the canonical TypeScript shape and shouldn't be ported. This v2 reflects what the TypeScript SDK actually ships on `bokelley/decisioning-platform-v1-scaffold` (PR #1005) after rounds 1-7 of expert review.

## Background

The TypeScript scaffold at [`src/lib/server/decisioning/`](../../src/lib/server/decisioning/) is the canonical surface. The Python port targets two adopter groups:

1. **The salesagent server** ([`adcontextprotocol/salesagent`](https://github.com/adcontextprotocol/salesagent)) — Flask + SQLAlchemy + Pydantic 2. Today it's a thin tool-decorator over per-adapter classes (GAM, Kevel, scope3 wrappers); idempotency, signing, sandbox, and status-change are hand-rolled per tool. The unified hybrid shape collapses 14 method names into 7, and the framework absorbs the cross-cutting concerns.
2. **Single-tenant Python adopters** (Innovid training-agent class, signals providers, retail-media networks). These run one platform impl, often with `'derived'` account resolution; the framework's tenant-scoped invariants still apply.

The v6.0 framework owns wire mapping, account resolution, async tasks, idempotency, RFC 9421 signing, schema validation, sandbox routing, status-change projection, and lifecycle observability. Adopters describe their platform once via per-specialism `Protocol` classes; the framework does the rest.

**Reference reading:**

- [`docs/proposals/decisioning-platform-v1.md`](./decisioning-platform-v1.md) — original TS design proposal
- [`docs/proposals/decisioning-platform-v2-hitl-split.md`](./decisioning-platform-v2-hitl-split.md) — the HITL split that motivated unified hybrid
- [`skills/build-decisioning-platform/SKILL.md`](../../skills/build-decisioning-platform/SKILL.md) — adopter-facing canonical surface (the Python SKILL must mirror this)
- [`.changeset/decisioning-platform-v1-scaffold.md`](../../.changeset/decisioning-platform-v1-scaffold.md) — round-by-round design log
- [`src/lib/server/decisioning/specialisms/sales.ts`](../../src/lib/server/decisioning/specialisms/sales.ts) — the unified hybrid `SalesPlatform` interface
- [`src/lib/server/decisioning/async-outcome.ts`](../../src/lib/server/decisioning/async-outcome.ts) — `AdcpError` + `TaskHandoff` brand mechanism
- [`src/lib/server/decisioning/tenant-registry.ts`](../../src/lib/server/decisioning/tenant-registry.ts) — multi-tenant primitive
- [`examples/decisioning-platform-mock-seller.ts`](../../examples/decisioning-platform-mock-seller.ts) — gold-standard hybrid sample
- [`examples/decisioning-platform-broadcast-tv.ts`](../../examples/decisioning-platform-broadcast-tv.ts) — HITL-heavy hybrid sample

## What changed since v1

| v1 design | v2 design | Why |
|---|---|---|
| `AsyncOutcome[T]` discriminated union (`Sync` / `Submitted` / `Rejected`) | Plain `T \| TaskHandoff[T]` return + `raise AdcpError` | Round-2 hybrid feedback (salesagent): dual outcome union forced upfront sync-vs-HITL choice; hybrid sellers branch per call. Round-3: `AdcpError` raise-path matches Flask/FastAPI/tRPC idioms; LLM-generated adopter code consistently picked it on first try. |
| `*Task` dual methods (`createMediaBuy` + `createMediaBuyTask`) | One method per tool returning `Success \| TaskHandoff[Success]` | Salesagent flagged: a real publisher commonly sells both kinds of inventory through the same tool. Dual methods forced "always declare HITL, resolve immediately on fast path" anti-pattern that taxes the 99% programmatic case with `tasks_get` polling. |
| `ctx.task: TaskHandle \| None` field on `RequestContext` | `ctx.handoff_to_task(fn)` constructor returning `TaskHandoff[T]` marker | Brand-marker is forgery-resistant by construction; only sanctioned producer is `handoff_to_task`. |
| `AccountNotFoundError` thrown class | Same — keep, narrow-use only from `accounts.resolve()` | No change. |
| 30-value `ErrorCode` union | 45-value union matching `schemas/cache/3.0.0/enums/error-code.json` | Spec catch-up (round-3). |
| No `TenantRegistry` | Multi-tenant primitive with subdomain + path-prefix routing, JWKS validator, `'pending'` health state | Training-agent migration + adoption-validation rounds 4-5. |
| No `publish_status_change` | Status-change bus shipped + per-server `server.status_change` field | Round-7 Emma sims surfaced the cross-test-contamination bug; per-server bus closes it. |
| `partial_result` on `Submitted` | Removed — off-spec drift | Salesagent feedback round-2: partial result was an "ergonomic feature" that didn't validate against spec receivers. |

## Scope

**In-scope:**

- Framework primitives: server factory, dispatch seam, idempotency, signing, validation, sandbox boundary
- 12 per-specialism `Protocol` classes
- Account resolution (3-mode), tenant registry, observability hooks
- Wire-shape parity with TypeScript SDK (must round-trip the same `mcp-webhook-payload.json`, `tasks-get-response.json`, etc.)
- Adopter-experience parity: write one platform class, framework owns the rest
- Migration paths from existing salesagent shape

**Out-of-scope:**

- Per-adopter migration of GAM / Kevel / scope3 / Innovid adapters (each adopter writes its own `SalesPlatform` impl; the salesagent's existing per-adapter classes become the bodies of those impls)
- MCP Resources subscription wire projection (parked behind AdCP 3.1)
- Compile-time enforcement (Python doesn't have `RequiredPlatformsFor<S>`)
- Symbol-keyed brand types (Python uses `WeakValueDictionary` instead — see § *Hybrid handoff*)

## Goals / Non-goals

**Goals:**

1. **Wire-shape parity** with the TypeScript SDK at the AdCP wire version (`schemas/cache/3.0.0/`). A buyer's MCP/A2A request that succeeds against `@adcp/client` must succeed against `@adcp/python-server` with the same response payload, modulo serialization order.
2. **Adopter-experience parity.** The Python SKILL has the same canonical example as the TypeScript SKILL, same fields, same error codes, same migration sketch.
3. **Migration path** from the salesagent's current Flask + per-adapter shape that doesn't require a rewrite — `@tool` decorators stay, per-adapter classes become `SalesPlatform` impls, framework absorbs idempotency / signing / sandbox / status-change.
4. **Async-or-sync method support.** Adopter methods can be either; the framework awaits both via `inspect.iscoroutinefunction`. Flask salesagent is sync today; FastAPI adopters are async; both must work without forking.

**Non-goals:**

1. Compile-time gates. The TS-side `RequiredPlatformsFor<'sales-broadcast-tv'> = SalesPlatformHitl` design-time signal does not have a Python equivalent; runtime `validate_platform()` fires the same diagnostic at server boot, but the gap is real and adopters should expect it.
2. Symbol-keyed brand types for `TaskHandoff`. The TS-side `Symbol.for('@adcp/decisioning/task-handoff')` brand is replaced with a `WeakValueDictionary`-backed marker in Python (see below).
3. New protocol shapes. Nothing in this RFC adds wire surface that doesn't already exist in AdCP 3.0 GA. If the spec evolves, Python and TypeScript track it together.

## Design

### Specialism Protocol classes

Twelve specialisms map to twelve `Protocol` classes:

| Specialism | Protocol class | Notes |
|---|---|---|
| `sales-non-guaranteed`, `sales-guaranteed`, `sales-broadcast-tv`, `sales-streaming-tv`, `sales-social`, `sales-exchange`, `sales-proposal-mode`, `sales-catalog-driven`, `sales-retail-media` | `SalesPlatform[TMeta]` | One unified hybrid shape covers all 9 sales specialisms |
| `audience-sync` | `AudiencePlatform[TMeta]` | |
| `signal-marketplace`, `signal-owned` | `SignalsPlatform[TMeta]` | |
| `creative-ad-server` | `CreativeAdServerPlatform[TMeta]` | HITL S&P review hybrid |
| `creative-template` | `CreativeTemplatePlatform[TMeta]` | |
| `creative-generative` | `CreativeGenerativePlatform[TMeta]` | |
| `governance-spend-authority`, `governance-delivery-monitor` | `CampaignGovernancePlatform[TMeta]` | |
| `property-lists` | `PropertyListsPlatform[TMeta]` | |
| `collection-lists` | `CollectionListsPlatform[TMeta]` | |
| `content-standards` | `ContentStandardsPlatform[TMeta]` | |
| `brand-rights` | `BrandRightsPlatform[TMeta]` | |
| `signed-requests` | (cross-cutting; no Protocol) | Wired on `serve(authenticate=...)` |
| `measurement-verification` | (preview; no Protocol yet) | |

`TMeta` is the per-platform metadata generic — `Account[TMeta]` carries `metadata: TMeta` so adopter-defined fields (`affiliate_id`, `network_id`, etc.) typecheck inside method bodies without casting. Defaults to `dict[str, Any]` for adopters who don't care.

**Reference: full `SalesPlatform` shape** — mirrors [`specialisms/sales.ts:127-220`](../../src/lib/server/decisioning/specialisms/sales.ts):

```python
from __future__ import annotations
from typing import Protocol, Generic, TypeVar, Awaitable, Union
from collections.abc import Awaitable as _Awaitable

# Wire types — auto-generated from schemas/cache/3.0.0/*.json via
# datamodel-code-generator. Adopters import from adcp_server.types.
from adcp_server.types import (
    GetProductsRequest, GetProductsResponse,
    CreateMediaBuyRequest, CreateMediaBuySuccess,
    UpdateMediaBuyRequest, UpdateMediaBuySuccess,
    GetMediaBuyDeliveryRequest, GetMediaBuyDeliveryResponse,
    CreativeAsset,
)
from adcp_server.async_outcome import TaskHandoff
from adcp_server.context import RequestContext

TMeta = TypeVar("TMeta", default=dict)  # PEP 696 default; falls back to TypeVar without default on 3.10

class SalesPlatform(Protocol, Generic[TMeta]):
    """Unified hybrid SalesPlatform — one method per tool. Methods may be
    sync (return T directly) or async (return Awaitable[T]); framework
    detects via inspect.iscoroutinefunction at dispatch time.

    Hybrid sellers (programmatic remnant + guaranteed inventory in one
    tenant) branch per call: return Success directly for the sync fast
    path, return ctx.handoff_to_task(fn) for the HITL slow path.

    Throw AdcpError for buyer-fixable rejection; framework projects to
    wire envelope (code, recovery, field, suggestion, retry_after,
    details).
    """

    def get_products(
        self,
        req: GetProductsRequest,
        ctx: RequestContext[TMeta],
    ) -> Awaitable[GetProductsResponse] | GetProductsResponse:
        """Sync catalog read — no HITL even on broadcast/proposal-mode.
        Brief-based proposal generation rides on a separate verb
        (adcp#3407 request_proposal); proposal-mode adopters surface
        the eventual products via publish_status_change(resource_type=
        'proposal').
        """
        ...

    def create_media_buy(
        self,
        req: CreateMediaBuyRequest,
        ctx: RequestContext[TMeta],
    ) -> (
        Awaitable[CreateMediaBuySuccess | TaskHandoff[CreateMediaBuySuccess]]
        | CreateMediaBuySuccess
        | TaskHandoff[CreateMediaBuySuccess]
    ):
        """Unified hybrid. Return CreateMediaBuySuccess directly for sync
        fast path; return ctx.handoff_to_task(fn) for HITL slow path.

        Pre-flight runs sync regardless of path so bad budgets reject
        before allocating a task id.

        Buyer pattern-matches on the response: media_buy_id field →
        sync; task_id + status='submitted' → poll tasks_get or webhook.
        """
        ...

    def update_media_buy(
        self,
        media_buy_id: str,
        patch: UpdateMediaBuyRequest,
        ctx: RequestContext[TMeta],
    ) -> Awaitable[UpdateMediaBuySuccess] | UpdateMediaBuySuccess:
        ...

    def sync_creatives(
        self,
        creatives: list[CreativeAsset],
        ctx: RequestContext[TMeta],
    ) -> (
        Awaitable[list[SyncCreativesRow] | TaskHandoff[list[SyncCreativesRow]]]
        | list[SyncCreativesRow]
        | TaskHandoff[list[SyncCreativesRow]]
    ):
        """Unified hybrid for creative review. Mixed approved/pending
        rows in a single sync response, OR hand off the whole batch to
        background S&P review."""
        ...

    def get_media_buy_delivery(
        self,
        filter: GetMediaBuyDeliveryRequest,
        ctx: RequestContext[TMeta],
    ) -> Awaitable[GetMediaBuyDeliveryResponse] | GetMediaBuyDeliveryResponse:
        ...

    # Optional methods — present-or-absent; framework detects via hasattr.
    # These are the four canonical sales tools that v6.0 added in rc.1
    # for retail-media + financials adopters.

    def get_media_buys(self, ...) -> ...: ...
    def provide_performance_feedback(self, ...) -> ...: ...
    def list_creative_formats(self, ...) -> ...: ...
    def list_creatives(self, ...) -> ...: ...

    # sales-catalog-driven / sales-retail-media specialism methods:
    def sync_catalogs(self, ...) -> ...: ...
    def log_event(self, ...) -> ...: ...
    def sync_event_sources(self, ...) -> ...: ...
```

**`AudiencePlatform` shape** — same hybrid pattern; `sync_audiences` returns sync rows, lifecycle flows through `publish_status_change`:

```python
class AudiencePlatform(Protocol, Generic[TMeta]):
    def sync_audiences(
        self,
        audiences: list[Audience],
        ctx: RequestContext[TMeta],
    ) -> Awaitable[list[SyncAudiencesRow]] | list[SyncAudiencesRow]:
        """Sync acknowledgment with status changes via publish_status_change.
        Return per-audience result rows immediately ('processing' is fine);
        match-rate computation and activation pipeline run in background."""
        ...

    def get_audience_status(
        self,
        audience_id: str,
        ctx: RequestContext[TMeta],
    ) -> Awaitable[AudienceStatus] | AudienceStatus:
        ...
```

**No more `*Task` methods.** v1's dual-method shape is dropped.

### Hybrid handoff (`ctx.handoff_to_task`)

The TypeScript brand-marker mechanism is module-private function storage in a `WeakMap` keyed by the marker object — adopters can hold the marker and pass it through return values, but cannot extract or invoke the function themselves. Forgery-resistant by construction.

**Python equivalent:** `weakref.WeakValueDictionary` keyed by `id(marker)` plus a frozen dataclass marker. The function lives in module scope; the marker is a sentinel object the adopter cannot synthesize without going through `ctx.handoff_to_task(fn)`.

```python
# adcp_server/async_outcome.py
import weakref
from dataclasses import dataclass
from typing import Generic, TypeVar, Callable, Awaitable

TResult = TypeVar("TResult")

@dataclass(frozen=True)
class TaskHandoff(Generic[TResult]):
    """Marker the framework recognizes as 'promote this call to a task.'
    Returned from ctx.handoff_to_task(fn). Adopters never construct
    directly — the only sanctioned producer is handoff_to_task.

    Forgery-resistant: the function is stored in a module-private
    WeakValueDictionary keyed by id(self); a forged marker not created
    by handoff_to_task won't be in the dict and the framework's
    _extract_task_fn returns None (treats it as sync success).
    """
    _marker_id: int  # opaque; do not construct manually

# Module-private storage — framework-only access via _extract_task_fn.
_task_handoff_fns: weakref.WeakValueDictionary[int, _HandoffFn] = weakref.WeakValueDictionary()
# Strong refs prevent GC while the handoff is in-flight; framework
# clears after dispatch.
_task_handoff_strong_refs: dict[int, _HandoffFn] = {}

class _HandoffFn:
    """Wraps the user function so WeakValueDictionary can hold it."""
    __slots__ = ("fn",)
    def __init__(self, fn): self.fn = fn

def _create_task_handoff(fn: Callable[[TaskHandoffContext], Awaitable[TResult]]) -> TaskHandoff[TResult]:
    """Framework-internal — adopters call ctx.handoff_to_task(fn) instead."""
    wrapper = _HandoffFn(fn)
    marker = TaskHandoff(_marker_id=id(wrapper))
    _task_handoff_fns[id(wrapper)] = wrapper
    _task_handoff_strong_refs[id(wrapper)] = wrapper  # strong ref
    return marker

def _extract_task_fn(handoff: TaskHandoff[TResult]) -> Callable | None:
    wrapper = _task_handoff_fns.get(handoff._marker_id)
    return wrapper.fn if wrapper else None

def _release_task_fn(handoff: TaskHandoff) -> None:
    """Framework calls this after dispatching the handoff to free
    the strong ref. WeakValueDictionary cleans up after."""
    _task_handoff_strong_refs.pop(handoff._marker_id, None)
```

`ctx.handoff_to_task(fn)`:

```python
# adcp_server/context.py
class RequestContext(Generic[TMeta]):
    account: Account[TMeta]
    state: StateReader  # workflow steps, proposals, governance JWS
    resolve: Resolver  # property/collection-list + format fetchers (rc.1+)

    def handoff_to_task(
        self,
        fn: Callable[[TaskHandoffContext], Awaitable[TResult]] | Callable[[TaskHandoffContext], TResult],
    ) -> TaskHandoff[TResult]:
        """Promote this call to a background task. Buyer sees
        {status: 'submitted', task_id} on the immediate response;
        framework runs fn after returning, persists fn's terminal
        artifact to the task registry, and emits push-notification
        webhook on terminal state.

        fn receives TaskHandoffContext carrying:
          - id: framework-issued task UUID
          - update(progress): write progress payload, transition
            'submitted' → 'working'
          - heartbeat(): liveness signal (v6.1 stub)
        """
        return _create_task_handoff(fn)
```

**Why not `weakref.WeakKeyDictionary` keyed by the marker object directly?** Frozen dataclasses can't be used as `WeakKeyDictionary` keys without `__weakref__` slot manipulation; keying by `id()` and storing a strong ref to a wrapper avoids the GC-during-dispatch race.

**Why not a private class?** Adopters who do `from adcp_server.async_outcome import TaskHandoff` need the symbol; making it `_TaskHandoff` breaks `Protocol` method signatures.

### Account resolution (3-mode)

Same as TypeScript — `'explicit'` / `'implicit'` / `'derived'` covers the deployment shapes:

```python
from typing import Literal, TypeVar, Generic
from collections.abc import Awaitable

class AccountStore(Protocol, Generic[TMeta]):
    resolution: Literal['explicit', 'implicit', 'derived']

    def resolve(
        self,
        ref: AccountReference | None,
        ctx: ResolveContext | None = None,
    ) -> Awaitable[Account[TMeta]] | Account[TMeta]:
        """Resolve an Account from the wire reference + transport-level
        auth context. The framework calls this for every tool dispatch;
        adopters in 'explicit' mode use ref.account_id; 'derived' mode
        ignores ref and returns the singleton; 'implicit' mode reads
        ctx.auth_info to look up the principal-bound account."""
        ...

    def upsert(self, ...) -> ...: ...
    def list(self, ...) -> ...: ...
    def report_usage(self, ...) -> ...: ...
    def get_account_financials(self, ...) -> ...: ...
```

**Salesagent migration:**

The salesagent today reads `g.tenant` from a Flask `before_request` hook (`tenants/<tenant_id>/...` URL pattern). That stays — but the body of the `@tool` decorator becomes:

```python
# Before (salesagent today):
@tool('create_media_buy')
def create_media_buy_handler(req):
    tenant = g.tenant
    adapter = tenant.adapter  # GAMAdapter, KevelAdapter, etc.
    return adapter.create_media_buy(req)

# After (v6.0 framework):
class SalesAgentSeller(SalesPlatform):
    accounts = SalesAgentAccounts(resolution='explicit')

    def create_media_buy(self, req, ctx):
        # ctx.account is the resolved tenant — same shape as g.tenant
        # was, with metadata: TenantMeta carrying adapter + config
        adapter = ctx.account.metadata.adapter
        return adapter.create_media_buy(req, ctx)

class SalesAgentAccounts:
    resolution = 'explicit'

    def resolve(self, ref, ctx=None):
        tenant_id = ref.account_id if ref else None
        if not tenant_id:
            raise AccountNotFoundError(...)
        # Existing salesagent tenant lookup
        return tenant_to_account(load_tenant(tenant_id))
```

The `@tool` decorator goes away; `serve(create_adcp_server_from_platform(seller, ...))` registers all wire tools the platform's specialisms claim.

### Async/sync method support

Python adopters can write methods as either `def` or `async def`. The framework detects at dispatch time:

```python
import inspect

async def _dispatch(method, *args, **kwargs):
    result = method(*args, **kwargs)
    if inspect.iscoroutine(result):
        return await result
    return result
```

This matters because Flask salesagent is synchronous (sync DB drivers, sync request bodies). Forcing it to migrate to async-everywhere is a large rewrite that doesn't gate on this feature. FastAPI adopters get native async; both work in the same framework.

**Tradeoff:** lose static analysis of "did the adopter forget to await something." `mypy --strict` won't catch a missing `await` in a sync method that's calling an async dependency. Adopters who care opt into async-everywhere; adopters who don't accept the runtime detection.

**Status-change publishing inside `def`-methods:** `publish_status_change(server, ...)` is sync (in-memory bus), so it works in both sync and async methods. `ctx.handoff_to_task(async_fn)` requires the handoff function itself to be async (the framework awaits it in a background task), but the method that returns the handoff can be sync.

### Error model (`AdcpError`)

```python
# adcp_server/errors.py
from typing import Literal, TypedDict, NotRequired

# 45 spec error codes from schemas/cache/3.0.0/enums/error-code.json
ErrorCode = Literal[
    'BUDGET_TOO_LOW', 'BUDGET_INVALID', 'INVALID_REQUEST',
    'POLICY_VIOLATION', 'PRODUCT_NOT_AVAILABLE',
    # ... (full 45-value list)
]

Recovery = Literal['retry_with_changes', 'transient', 'terminal', 'correctable']

class AdcpStructuredErrorDict(TypedDict):
    code: str  # ErrorCode | str (forward-compat for vendor codes)
    message: str
    recovery: Recovery
    field: NotRequired[str]
    suggestion: NotRequired[str]
    retry_after: NotRequired[int]
    details: NotRequired[dict]

class AdcpError(Exception):
    def __init__(
        self,
        code: ErrorCode | str,
        *,
        message: str = "",
        recovery: Recovery = 'terminal',
        field: str | None = None,
        suggestion: str | None = None,
        retry_after: int | None = None,
        details: dict | None = None,
    ):
        super().__init__(message or code)
        self.code = code
        self.recovery = recovery
        self.field = field
        self.suggestion = suggestion
        self.retry_after = retry_after
        self.details = details or {}

    def __str__(self) -> str:
        # Override mirrors AdcpError.toString() in TS — surfaces code +
        # recovery in default repr() / logging output
        return f"AdcpError[{self.code} / {self.recovery}]: {self.args[0]}"

    @property
    def is_known_code(self) -> bool:
        return self.code in _KNOWN_ERROR_CODES
```

**Multi-error preflight** — same pattern as TS:

```python
def preflight(req, config) -> list[AdcpStructuredErrorDict]:
    errors = []
    if total_budget(req) < config.floor_cpm * 1000:
        errors.append({
            'code': 'BUDGET_TOO_LOW',
            'message': f'total_budget below floor ({config.floor_cpm} CPM × 1000 imp)',
            'recovery': 'correctable',
            'field': 'total_budget',
        })
    return errors

def reject_preflight(errors):
    raise AdcpError(
        'INVALID_REQUEST',
        recovery='correctable',
        message=errors[0]['message'],
        field=errors[0].get('field'),
        details={'errors': errors},
    )
```

The framework catches `AdcpError` at the dispatch seam and projects to the wire `adcp_error` envelope. Generic `Exception` falls through to `SERVICE_UNAVAILABLE`.

### Status-change bus

```python
# adcp_server/status_changes.py
from typing import Callable, Literal, TypedDict

ResourceType = Literal[
    'media_buy', 'creative', 'audience', 'signal', 'proposal',
    'plan', 'rights_grant', 'delivery_report',
    'property_list', 'collection_list',
    # Vendor-specific keys allowed via 'x-' prefix per JSDoc convention
] | str

class StatusChangeEvent(TypedDict):
    account_id: str
    resource_type: ResourceType
    resource_id: str
    payload: dict  # freeform JSON — wire-validation off here
    timestamp: NotRequired[str]

class StatusChangeBus:
    def __init__(self):
        self._subscribers: list[Callable[[StatusChangeEvent], None]] = []

    def publish(self, event: StatusChangeEvent) -> None:
        for sub in self._subscribers:
            try:
                sub(event)
            except Exception as e:
                # Swallow — subscriber crashes must not break dispatch
                _logger.warning("status-change subscriber raised: %s", e)

    def subscribe(self, fn: Callable[[StatusChangeEvent], None]) -> Callable[[], None]:
        self._subscribers.append(fn)
        return lambda: self._subscribers.remove(fn)

# Module-level singleton for non-handler code (cron, webhook handlers)
# that doesn't hold a server reference.
_active_bus: StatusChangeBus | None = None

def publish_status_change(event: StatusChangeEvent) -> None:
    if _active_bus:
        _active_bus.publish(event)
```

`server.status_change` is a per-server `StatusChangeBus`; tests with multiple servers in one process don't cross-contaminate. Module-level `publish_status_change(...)` works for non-handler code.

**Tenant scoping:** every event carries `account_id`; subscribers filter by tenant. The framework's MCP Resources subscription projector (rc.1+) MUST fan in from BOTH the per-server bus AND the module-level bus.

### Idempotency

Framework persists response per `(idempotency_key, account_id)` and replays on duplicate keys. Persistence shape:

```sql
CREATE TABLE adcp_idempotency_keys (
    idempotency_key TEXT NOT NULL,
    account_id TEXT NOT NULL,
    response_payload JSONB NOT NULL,
    response_status SMALLINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (idempotency_key, account_id)
);
CREATE INDEX adcp_idempotency_keys_created_at ON adcp_idempotency_keys (created_at);
```

Framework reads `(idempotency_key, account.id)` at the top of dispatch; if hit, returns the cached response. Otherwise dispatches the method, captures the response, writes the key.

**Mutating tools that require `idempotency_key`** are listed in `MUTATING_TASKS` (mirrors the TS-side constant): `create_media_buy`, `update_media_buy`, `sync_accounts`, `sync_creatives`, `sync_audiences`, `sync_catalogs`, `sync_event_sources`, `sync_plans`, `sync_governance`, `provide_performance_feedback`, `acquire_rights`, `activate_signal`, `log_event`, `report_usage`, `report_plan_outcome`, plus the property-list / collection-list / content-standards CRUD operations.

The framework rejects mutating requests without an `idempotency_key` with `INVALID_REQUEST` at the dispatch seam (matches TS behavior).

### HTTP signatures (RFC 9421)

**Library choice: [`http-message-signatures`](https://pypi.org/project/http-message-signatures/)** by woodruffw, the most actively maintained pure-Python implementation as of 2026. Built on `cryptography`. Supports the signature subset AdCP requires (Ed25519 + RSA-PSS).

Wired on `serve(authenticate=...)` — same boundary as TypeScript. The platform never sees raw signatures; the verifier resolves the principal and threads it onto `ctx.account.auth_info`:

```python
from http_message_signatures import HTTPMessageSigner, HTTPMessageVerifier
from cryptography.hazmat.primitives.asymmetric import ed25519, rsa

def signed_request_verifier(public_key_resolver):
    """Returns a callable that verifies incoming RFC 9421 signatures and
    populates ctx.auth_info with the resolved principal."""
    verifier = HTTPMessageVerifier(
        signature_algorithm=...,
        key_resolver=public_key_resolver,
    )
    def verify(request) -> AuthInfo:
        result = verifier.verify(request)
        return AuthInfo(
            kind='signed_request',
            key_id=result.key_id,
            principal=result.label,
            scopes=result.metadata.get('scopes', []),
        )
    return verify

# Adopter wiring:
serve(
    create_adcp_server_from_platform(seller, ...),
    authenticate=signed_request_verifier(public_key_resolver=load_jwks),
)
```

**Outgoing webhook signing** uses the same library — when `signed-requests` is claimed, push-notification webhooks emit RFC 9421-signed `Signature` + `Signature-Input` headers. The framework owns this; adopters write zero signing code.

**Salesagent migration:** today the salesagent has hand-rolled signature verification (or none, depending on tenant config). Migration is: install `http-message-signatures`, wire `serve(authenticate=...)`, delete the per-tool verification code. Idempotency-key + signing become framework concerns.

### Webhook delivery

Push-notification config rides on the buyer's mutating request:

```python
class PushNotificationConfig(TypedDict):
    url: str  # MUST be https:// (or test-env override)
    token: NotRequired[str]  # MUST be ≤ 255 chars, no control characters
```

Framework owns the SSRF guard. Port the TypeScript validator from [`runtime/from-platform.ts`](../../src/lib/server/decisioning/runtime/from-platform.ts):

```python
import ipaddress
from urllib.parse import urlparse

def validate_push_notification_url(url: str) -> None:
    """Reject SSRF surfaces. Raises AdcpError(INVALID_REQUEST) for any
    of: non-https scheme (test/dev override via env),
    bare 'localhost'/'0', RFC 1918 (10/8, 172.16/12, 192.168/16),
    loopback (127/8, ::1), link-local (169.254/16 incl. AWS metadata,
    fe80::/10), CGNAT (100.64/10), IPv6 unique-local (fc00::/7),
    multicast/reserved, IPv4-mapped IPv6, bracketed IPv6 hosts.
    """
    parsed = urlparse(url)
    if parsed.scheme != 'https' and not _allow_http_test_override():
        raise AdcpError('INVALID_REQUEST', field='push_notification_config.url',
                        message=f'scheme {parsed.scheme!r} not allowed; must be https')
    host = parsed.hostname or ''
    # Strip IPv6 brackets
    if host.startswith('[') and host.endswith(']'):
        host = host[1:-1]
    # IPv4-mapped IPv6: ::ffff:127.0.0.1 → recurse on dotted-quad
    if host.lower().startswith('::ffff:'):
        validate_push_notification_url(url.replace(host, host.split(':')[-1]))
        return
    if host in ('localhost', '0'):
        raise AdcpError('INVALID_REQUEST', field='push_notification_config.url',
                        message=f'host {host!r} not allowed')
    try:
        ip = ipaddress.ip_address(host)
        if ip.is_loopback or ip.is_link_local or ip.is_private \
                or ip.is_multicast or ip.is_reserved \
                or ip in ipaddress.ip_network('100.64.0.0/10'):
            raise AdcpError('INVALID_REQUEST', field='push_notification_config.url',
                            message=f'host {host!r} resolves to disallowed range')
    except ValueError:
        # Hostname; DNS rebinding caveat — see below
        pass

def validate_push_notification_token(token: str) -> None:
    if len(token) == 0:
        raise AdcpError('INVALID_REQUEST', field='push_notification_config.token',
                        message='token is empty')
    if len(token) > 255:
        raise AdcpError('INVALID_REQUEST', field='push_notification_config.token',
                        message='token exceeds 255 chars')
    if any(ord(c) < 32 or ord(c) == 127 for c in token):
        raise AdcpError('INVALID_REQUEST', field='push_notification_config.token',
                        message='token contains control characters')
```

**DNS rebinding caveat:** the validator inspects the literal hostname; a buyer can register `https://rebind.attacker.com/` with a TTL-0 A-record that returns `8.8.8.8` at validate time and `127.0.0.1` at fetch time. Production adopters mitigate via egress proxy with allowlist (deployment-side) or pin-and-bind custom HTTP client (SDK-side). v6.1 ships a `create_pin_and_bind_session()` helper for `httpx.AsyncClient`. Tracking issue [adcp-client#1038](https://github.com/adcontextprotocol/adcp-client/issues/1038).

**Webhook envelope** matches `mcp-webhook-payload.json`:

```python
class WebhookPayload(BaseModel):
    idempotency_key: str  # UUID v4, framework-generated
    task_id: str
    task_type: str  # tool name
    status: Literal['completed', 'failed', ...]
    timestamp: str  # ISO 8601
    protocol: Literal['media-buy', 'creative', 'signals',
                       'governance', 'brand', 'sponsored-intelligence']
    message: str | None = None  # populated on failed
    result: dict | None = None  # success arm body for completed
    error: dict | None = None  # {errors: [structured_error]} for failed
```

Webhook delivery is gated to spec-listed task types (closed enum at AdCP 3.0 GA); the framework skips webhook emission with an explanatory log for tools outside the enum and uses `publish_status_change` instead.

### Task registry

Framework-owned. In-memory default for tests/dev, Postgres for production.

**Library choice: `asyncpg`** for the Postgres registry, NOT SQLAlchemy. Rationale:

1. **Mixed sync/async dispatch.** The framework awaits both sync and async adopter methods. Wrapping SQLAlchemy 2.0 async sessions inside a sync method's dispatch path creates an event-loop-in-thread mess; `asyncpg` directly under `asyncio.run()` is cleaner.
2. **Salesagent already uses SQLAlchemy** for tenant + adapter persistence — adopters own that schema. The framework's task registry is a separate concern with a fixed schema; not coupling them lets adopters keep their existing SQLAlchemy code without forcing it through the framework.
3. **Performance.** `asyncpg` outperforms SQLAlchemy + `psycopg` by 2-3x on the registry's hot path (insert + status-update on terminal task). The framework's task registry is a high-write surface; the perf delta matters at scale.

Schema (mirrors TS Postgres migration):

```sql
CREATE TABLE adcp_decisioning_tasks (
    task_id UUID PRIMARY KEY,
    account_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
        'submitted', 'working', 'input-required',
        'completed', 'canceled', 'failed', 'rejected',
        'auth-required', 'unknown'
    )),
    progress JSONB,
    result JSONB,
    error JSONB,
    has_webhook BOOLEAN NOT NULL DEFAULT FALSE,
    push_notification_url TEXT,
    push_notification_token TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);
CREATE INDEX adcp_decisioning_tasks_account_id ON adcp_decisioning_tasks (account_id);
```

Framework writes `submitted` on task creation, `working` on first `update(progress)`, `completed` / `failed` on terminal. Other 5 enum values reserved for adopter-emitted transitions via the v6.1 `task_registry.transition()` API.

**Result/error JSONB cap at 4 MB** — same as TypeScript; adopter `*Task` returning oversized payloads no longer OOMs the Python process before pg complains.

**Multi-tenant deployments** sharing one registry: namespace task IDs as `tenant_{tenant_id}_{account_id}_{uuid}` so cross-tenant `get_task(task_id)` probes return null even when the same UUID was minted for multiple tenants. Defense in depth on top of the framework's tenant-scoped `get_task_state(task_id, expected_account_id)`.

### Tenant registry

Multi-tenant primitive — same surface as TS [`tenant-registry.ts`](../../src/lib/server/decisioning/tenant-registry.ts):

```python
from typing import Literal, Callable, Awaitable

class TenantConfig(TypedDict, Generic[TPlatform]):
    agent_url: str  # https://acme.example.com or https://example.com/acme
    signing_key: TenantSigningKey
    platform: TPlatform
    label: str | None = None
    server_options: ServerOptions | None = None

class TenantSigningKey(TypedDict):
    key_id: str
    public_jwk: dict  # JWKS public-key shape
    private_jwk: dict  # JWKS private-key shape

class TenantRegistry:
    def register(
        self,
        tenant_id: str,
        config: TenantConfig,
        *,
        await_first_validation: bool = False,
    ) -> Awaitable[None] | None:
        """Register a tenant. Lands in 'pending' health until JWKS
        validation succeeds. await_first_validation=True returns the
        validation outcome synchronously so deploy scripts can gate."""
        ...

    def unregister(self, tenant_id: str) -> None: ...

    def resolve_by_host(
        self, host: str
    ) -> tuple[str, TenantConfig, DecisioningAdcpServer] | None:
        """Subdomain routing — convenience wrapper for resolve_by_request(host, '/')."""
        ...

    def resolve_by_request(
        self, host: str, pathname: str
    ) -> tuple[str, TenantConfig, DecisioningAdcpServer] | None:
        """Path-based routing — matches host AND longest-path-prefix.
        Strips query strings and fragments before matching."""
        ...

    # ... unregister, recheck, list_tenants
```

**Health states:** `'pending'` (just registered, awaiting first JWKS validation), `'healthy'` (validation succeeded), `'unverified'` (was healthy, hit a transient recheck failure — still serves for graceful degradation), `'disabled'` (validation failed permanently).

**JWKS race window:** `register()` previously dropped tenants in `'unverified'` — meaning the framework would serve signed responses no buyer could verify for ~60s. v6.0 closes the race: tenants land in `'pending'`, `resolve_by_host` returns null for `'pending'`, host transport responds 503 + Retry-After until first validation succeeds.

**Admin-API auth:** `register()` JSDoc explicitly notes that any caller invoking `register()` can introduce a tenant that signs outbound webhooks; hosts wiring an HTTP/RPC endpoint in front MUST gate it with operator-level auth (mTLS, signed JWT, etc.). Framework doesn't ship admin-HTTP scaffolding because the right auth shape varies by deployment.

**Salesagent migration:** salesagent is currently single-tenant per process (or proxy-based multi-tenant). For multi-tenant deployments under the registry pattern, the migration is:

```python
# Before (salesagent today):
@app.before_request
def load_tenant():
    g.tenant = lookup_tenant_from_subdomain(request.host)

# After (v6.0):
registry = create_tenant_registry(default_server_options=...)
for tenant in load_all_tenants():
    registry.register(
        tenant.id,
        TenantConfig(
            agent_url=tenant.agent_url,
            signing_key=tenant.signing_key,
            platform=SalesAgentSeller(tenant_metadata=tenant.metadata),
        ),
    )

# Wire the framework's host-routing factory:
serve(
    factory=lambda ctx: registry.resolve_by_host(ctx.host)[2],  # the server
    authenticate=signed_request_verifier(...),
)
```

### Observability hooks

Decision: **`dataclass` of optional callable fields**, not a `Protocol` class. Reasoning:

1. **Python convention** — sklearn, FastAPI, httpx all expose hooks as callable bags, not Protocol classes. Adopters wire one hook without subclassing or implementing every method.
2. **Optionality is cleaner** — Protocol with optional methods requires `# type: ignore[empty-body]` or `...` stubs. Dataclass with `Callable | None = None` reads naturally.
3. **Forward-compat** — adding a new hook to a dataclass is non-breaking (default `None`); adding a new method to a Protocol breaks every implementer.

```python
from dataclasses import dataclass, field
from typing import Callable

@dataclass
class DecisioningObservabilityHooks:
    on_account_resolve: Callable[[AccountResolveEvent], None] | None = None
    on_task_create: Callable[[TaskCreateEvent], None] | None = None
    on_task_transition: Callable[[TaskTransitionEvent], None] | None = None
    on_webhook_emit: Callable[[WebhookEmitEvent], None] | None = None
    on_status_change_publish: Callable[[StatusChangePublishEvent], None] | None = None
    # Per-tool dispatch latency hooks land in v6.1
    # on_dispatch_start: ...
    # on_dispatch_end: ...

@dataclass
class AccountResolveEvent:
    tenant_id: str | None
    account_id: str | None  # may be None on resolution failure
    duration_ms: float
    from_auth: bool  # True when auth-derived path
    success: bool
    error_code: str | None = None

# ... similar for the other 4
```

**Throw-safe** — adopter telemetry mistakes are caught + logged via the framework logger, never break dispatch:

```python
def _safe_fire(hook, event):
    if hook is None:
        return
    try:
        result = hook(event)
        if inspect.iscoroutine(result):
            # Schedule on the event loop; warn on rejection
            asyncio.ensure_future(result).add_done_callback(_log_hook_rejection)
    except Exception as e:
        _logger.warning("observability hook raised: %s", e)
```

## Migration paths

### From salesagent (Flask + per-adapter classes)

**Step 1.** Install `adcp-server` (or `@adcp/python-server` — see open question on naming).

**Step 2.** Convert one `MediaBuyAdapter` ABC to a `SalesPlatform` impl:

```python
# Before: tenants/<id>/adapters/gam.py
class GAMAdapter(MediaBuyAdapter):
    def create_media_buy(self, req): ...
    def update_media_buy(self, mb_id, patch): ...
    # etc.

# After: tenants/<id>/platforms/gam.py
class GAMSalesPlatform(SalesPlatform):
    def __init__(self, tenant):
        self._tenant = tenant
        self._gam_client = GoogleAdsClient(...)

    def create_media_buy(self, req, ctx):
        # Same body as the old adapter — read tenant from ctx.account.metadata
        # instead of g.tenant
        if self._is_pre_approved(req, ctx.account.metadata):
            buy = self._gam_client.create_immediate(req)
            return CreateMediaBuySuccess(media_buy_id=buy.id, status='pending_creatives', ...)
        # Hybrid HITL — slow path
        return ctx.handoff_to_task(async lambda task_ctx: self._gam_client.create_with_review(req, task_ctx))
```

**Step 3.** Wire the framework:

```python
# salesagent/server.py
from adcp_server import serve, create_adcp_server_from_platform

def make_seller(tenant) -> SalesAgentSeller:
    return SalesAgentSeller(
        capabilities=DecisioningCapabilities(...),
        accounts=SalesAgentAccounts(resolution='explicit', tenant=tenant),
        sales=GAMSalesPlatform(tenant),
        # ...
    )

if __name__ == '__main__':
    registry = create_tenant_registry()
    for tenant in load_all_tenants():
        registry.register(tenant.id, TenantConfig(
            agent_url=tenant.agent_url,
            signing_key=tenant.signing_key,
            platform=make_seller(tenant),
        ))
    serve(
        factory=lambda ctx: registry.resolve_by_host(ctx.host)[2],
        authenticate=signed_request_verifier(...),
    )
```

**Step 4.** Delete:
- Hand-rolled idempotency middleware (framework owns it)
- Hand-rolled signature verifier (framework owns it via `authenticate=...`)
- Hand-rolled sandbox routing (framework owns it via `Account.metadata.sandbox`)
- Hand-rolled status-change emitter (replaced with `publish_status_change(event)`)

**Estimated migration effort** for one adapter: 2-3 days. The salesagent has 6+ adapters; staged migration is feasible (the merge seam in `serve()` accepts v5-style handler entries alongside v6 platforms, so adopters move sales/audiences/signals to v6 today and keep custom handlers for tools deferred to v6.1).

### From Innovid training-agent

Single-tenant agent. `'derived'` resolution returns a synthetic singleton account; the framework's tenant-scoped invariants (idempotency, status-change `account_id`, workflow steps) all work without forcing the adopter to model multi-tenancy:

```python
class TrainingAgentAccounts:
    resolution = 'derived'

    def resolve(self, ref, ctx=None):
        # Singleton — ignore ref, always return the one account
        return Account(
            id='training-agent',
            name='Innovid Training Agent',
            status='active',
            metadata={'kind': 'training_agent'},
            auth_info={'kind': 'derived'},
        )

class TrainingAgentSeller(SalesPlatform):
    accounts = TrainingAgentAccounts()
    # ... single platform, no per-tenant lookup
```

See [`docs/proposals/decisioning-platform-training-agent-migration.md`](./decisioning-platform-training-agent-migration.md) for the full migration plan.

### From scratch (new adopter)

Three-step intro mirrors the TS SKILL:

```python
# 1. Declare capabilities
class MySellerSeller(DecisioningPlatform):
    capabilities = DecisioningCapabilities(
        specialisms=['sales-non-guaranteed'],
        creative_agents=[CreativeAgent(agent_url='https://creative.example.com/mcp')],
        channels=['display', 'olv'],
        pricing_models=['cpm'],
        config={...},
    )

    accounts = MyAccounts(resolution='derived')

    sales = SalesPlatform(...)  # impl below

# 2. Implement specialism methods
class MySalesPlatform:
    def get_products(self, req, ctx): ...
    def create_media_buy(self, req, ctx): ...
    def update_media_buy(self, mb_id, patch, ctx): ...
    def sync_creatives(self, creatives, ctx): ...
    def get_media_buy_delivery(self, filter, ctx): ...

# 3. Serve
if __name__ == '__main__':
    seller = MySellerSeller()
    serve(create_adcp_server_from_platform(seller, name='my-seller', version='0.0.1'))
```

The Python SKILL ships a single canonical example mirroring [`skills/build-decisioning-platform/SKILL.md`](../../skills/build-decisioning-platform/SKILL.md) — same fields, same error codes, same migration sketch.

## Open questions

These need decisions before the Python port lands `rc.1`:

### 1. Async-vs-sync method dispatch

Should the framework **detect** sync/async at dispatch time (`inspect.iscoroutinefunction`), or **force** adopters to write async-everywhere?

- **Detect** — easier migration for sync codebases (Flask salesagent), but loses `mypy --strict` "did you forget an `await`" check inside sync methods that touch async I/O.
- **Force async** — cleaner type story, but forces salesagent to migrate to `asgiref.sync.async_to_sync` shims everywhere a sync DB driver is touched, which is invasive.

**RFC recommendation: detect.** The migration cost of forced async is too high; the type-checker gap is real but bounded.

### 2. Pydantic 2 vs `TypedDict` for wire types

Wire types come from `schemas/cache/<version>/*.json` via codegen. Two options:

- **Pydantic 2 BaseModel** — runtime validation, automatic serialization, ergonomic `model.field` access. Salesagent already uses it. Pays a small per-request validation cost.
- **TypedDict** — zero runtime cost, structural typing, but no runtime validation; adopters who accept buyer-supplied fields without validating wire-shape ship bugs to production.

**RFC recommendation: Pydantic 2.** Wire-shape is the framework's contract; runtime validation is a feature, not overhead. Adopters opting out for perf can subclass with `model_config = ConfigDict(arbitrary_types_allowed=True, validate_assignment=False)`.

### 3. Library naming + packaging cadence

Two naming schemes:

- `pip install adcp-server` — short, idiomatic Python, no namespacing
- `pip install @adcp/python-server` — matches TypeScript scope, but `@scope/name` packages don't render naturally on PyPI

**RFC recommendation: `adcp-server`** on PyPI; document the scope correspondence in the README.

**Version pinning:** the Python SDK ships its own version independent of the TypeScript SDK, but both pin to the same `ADCP_VERSION` (currently `3.0.0`). When AdCP 3.1 ships, both SDKs cut new majors that bump `ADCP_VERSION`; adopters who pin `adcp-server>=3.0,<4.0` and `@adcp/client@>=3.0.0 <4.0.0` get the same wire surface.

### 4. CI matrix — Python 3.10 / 3.11 / 3.12 / 3.13?

**RFC recommendation: 3.10 minimum** (PEP 604 union syntax `int | str`, `match` statement). Drop 3.9 — it's EoL October 2025; the salesagent is already on 3.11. Test 3.10, 3.11, 3.12, 3.13.

PEP 696 (`TypeVar` defaults — `TMeta = TypeVar("TMeta", default=dict)`) needs 3.13 for runtime support; on 3.10-3.12 we ship via `typing_extensions.TypeVar`.

### 5. Type-checker support — mypy strict, pyright strict, both?

**RFC recommendation: both, on every PR.** mypy strict is the standard; pyright strict catches things mypy doesn't (especially around `Protocol` variance and `TypeVar` defaults). The framework SHOULD type-check clean under both; adopter code is up to the adopter.

### 6. Submitted-arm spec consolidation (adcp#3392) — port wait or land alongside?

Currently TypeScript SDK ships `*Task` methods only for the two tools whose per-tool `xxx-response.json` schema includes the `Submitted` arm (`create_media_buy`, `sync_creatives`). The other 4 HITL-eligible tools (`update_media_buy`, `build_creative`, `sync_catalogs`, `get_products`) have inconsistent spec response schemas — `Submitted` is in `async-response-data.json` only.

[adcp#3392](https://github.com/adcontextprotocol/adcp/issues/3392) proposes spec consolidation so all 6 tools have rolled-in `Submitted` arms. When that lands, the SDK adds `*Task`-equivalent unified-hybrid methods for the other 4.

**RFC recommendation: Python port lands the same shape as TypeScript** — only `create_media_buy` + `sync_creatives` have hybrid handoff support in v6.0; the other 4 tools surface long-running state via `publish_status_change` until adcp#3392 lands.

## Appendix: Wire payload examples

### `create_media_buy` (sync fast path)

**Request (buyer → seller):**

```json
{
  "method": "tools/call",
  "params": {
    "name": "create_media_buy",
    "arguments": {
      "account": { "account_id": "acme_tenant_42" },
      "buyer_ref": "pre_approved",
      "products": [{ "product_id": "prod_premium_video" }],
      "total_budget": { "amount": 50000, "currency": "USD" },
      "idempotency_key": "8f4e2a1c-d6b8-4f9e-9a3c-7b1d5e8f2a4d"
    }
  }
}
```

**Response (TypeScript SDK + Python SDK identical):**

```json
{
  "structuredContent": {
    "media_buy_id": "mb_acme_1714271234",
    "status": "pending_creatives",
    "confirmed_at": "2026-04-28T13:47:14Z",
    "packages": []
  }
}
```

### `create_media_buy` (HITL slow path)

**Request:** same as above, but `buyer_ref` not pre-approved.

**Response (Submitted envelope):**

```json
{
  "structuredContent": {
    "task_id": "5b1e9a8c-3d2f-4f1e-8b9d-6a7c5f3d2b1a",
    "task_type": "create_media_buy",
    "status": "submitted",
    "timestamp": "2026-04-28T13:47:14Z",
    "protocol": "media-buy"
  }
}
```

Buyer polls via `tasks_get` or receives webhook on terminal state.

### `sync_audiences` (sync ack + status-change)

**Request:**

```json
{
  "method": "tools/call",
  "params": {
    "name": "sync_audiences",
    "arguments": {
      "account": { "account_id": "idg_acc_1" },
      "audiences": [{ "audience_id": "aud_42", "identifiers": ["e1", "e2", "e3", "e4"] }],
      "idempotency_key": "8f4e2a1c-d6b8-4f9e-9a3c-7b1d5e8f2a4d"
    }
  }
}
```

**Sync response:**

```json
{
  "structuredContent": {
    "audiences": [{
      "audience_id": "aud_42",
      "action": "created",
      "status": "processing",
      "matched_count": 0,
      "effective_match_rate": 0
    }]
  }
}
```

**Status-change events (later, via MCP Resources subscription or `tasks_get`):**

```json
{ "resource_type": "audience", "resource_id": "aud_42",
  "payload": { "stage": "matched", "status": "processing", "matched_count": 1680, "match_rate": 0.42 } }
{ "resource_type": "audience", "resource_id": "aud_42",
  "payload": { "stage": "activating", "status": "processing" } }
{ "resource_type": "audience", "resource_id": "aud_42",
  "payload": { "stage": "active", "status": "ready" } }
```

### `tasks_get` (Submitted task lifecycle)

**Request:**

```json
{
  "method": "tools/call",
  "params": {
    "name": "tasks_get",
    "arguments": {
      "task_id": "5b1e9a8c-3d2f-4f1e-8b9d-6a7c5f3d2b1a",
      "account": { "account_id": "acme_tenant_42" }
    }
  }
}
```

**Response (in-progress):**

```json
{
  "structuredContent": {
    "task_id": "5b1e9a8c-3d2f-4f1e-8b9d-6a7c5f3d2b1a",
    "task_type": "create_media_buy",
    "status": "working",
    "timestamp": "2026-04-28T13:48:30Z",
    "protocol": "media-buy",
    "has_webhook": true,
    "progress": { "stage": "trafficker_review", "step": "2_of_3" }
  }
}
```

**Response (completed):**

```json
{
  "structuredContent": {
    "task_id": "5b1e9a8c-3d2f-4f1e-8b9d-6a7c5f3d2b1a",
    "task_type": "create_media_buy",
    "status": "completed",
    "timestamp": "2026-04-28T15:22:11Z",
    "completed_at": "2026-04-28T15:22:11Z",
    "protocol": "media-buy",
    "has_webhook": true,
    "result": {
      "media_buy_id": "mb_acme_1714271234",
      "status": "active",
      "confirmed_at": "2026-04-28T15:22:11Z",
      "packages": [...]
    }
  }
}
```

## Appendix: Validation matrix

The Python port MUST pass equivalents of these TypeScript test files. Wire-shape parity is non-negotiable:

| TypeScript test | Python equivalent | What it pins |
|---|---|---|
| `test/server-decisioning-mock-seller.test.js` | `tests/test_mock_hybrid_seller.py` | Unified hybrid sync + HITL branch per call; `ctx.handoff_to_task` produces a marker the framework dispatches; pre-approved buyer fast-path returns wire `Success` directly |
| `test/server-decisioning-from-platform.test.js` | `tests/test_dispatch.py` | `AdcpError` raise-path projects to wire envelope; multi-error preflight `details.errors`; sandbox routing; idempotency-key replay; merge-seam collision warnings; auth-derived account resolution |
| `test/server-decisioning-tenant-registry.test.js` | `tests/test_tenant_registry.py` | Subdomain + path-prefix routing; `'pending'` health gate; JWKS fetch timeout; admin-API auth contract; query-string stripping |
| `test/server-decisioning-identity-graph.test.js` | `tests/test_audience_sync.py` | Sync ack + multi-stage `publish_status_change`; rich-internal-stage → wire-flat-status collapse; `effective_match_rate` field; rejection without status-change events |
| `test/server-decisioning-postgres-task-registry.test.js` | `tests/test_postgres_task_registry.py` | 9-value status enum; `progress` JSONB transitions; 4 MB result/error cap; `has_webhook` field; tenant-prefix namespacing |
| `test/server-decisioning-task-webhooks.test.js` | `tests/test_webhooks.py` | RFC 9421 signed delivery; SSRF guard rejections (50+ surfaces); failed-task error envelope; `task_type` closed-enum gate; idempotency-key UUIDv4 |
| `test/server-decisioning-status-changes.test.js` | `tests/test_status_changes.py` | Per-server bus isolation; module-level singleton fan-in; 10-value resource-type enum + `'x-'` forward-compat; tenant scoping |
| `test/server-decisioning-validate-platform.test.js` | `tests/test_validate_platform.py` | "Claimed X; missing Y" diagnostic; specialism-method coverage matrix; runtime check at server boot |

## Decision summary

1. **Async-or-sync method dispatch:** detect, not force.
2. **Wire types:** Pydantic 2 BaseModel.
3. **`TaskHandoff` brand seal:** `WeakValueDictionary` keyed by `id()` of an opaque `_HandoffFn` wrapper.
4. **Postgres library:** `asyncpg`, not SQLAlchemy.
5. **Observability hooks:** `dataclass` of optional callables, not Protocol.
6. **HTTP signatures:** `http-message-signatures` (woodruffw).
7. **Library name:** `adcp-server` on PyPI.
8. **Python versions:** 3.10 minimum; CI 3.10 / 3.11 / 3.12 / 3.13.
9. **Type checking:** mypy strict + pyright strict, both on every PR.
10. **Spec consolidation (adcp#3392):** Python ships same shape as TypeScript; hybrid handoff for `create_media_buy` + `sync_creatives` only in v6.0; other 4 HITL tools surface via `publish_status_change` until consolidation lands.

## Next moves

If the salesagent team and Python team accept this RFC:

1. Create `adcontextprotocol/adcp-python-server` repo with the SKILL, generated types, and core framework primitives (`AdcpError`, `TaskHandoff`, `RequestContext`, observability hooks).
2. Port `validate_platform()` + the 12 specialism `Protocol` classes.
3. Port `tenant_registry` + JWKS validator.
4. Port `postgres_task_registry` + in-memory variant.
5. Port the `mock-seller`, `broadcast-tv`, and `identity-graph` worked examples — same shape as TypeScript, idiomatic Python.
6. Wire `serve(authenticate=signed_request_verifier(...), webhooks=...)`.
7. Open the salesagent migration PR — convert one adapter end-to-end as a proof point.
8. CI parity — ensure the Python `tests/test_*.py` matrix above passes against the same `schemas/cache/3.0.0/` cache the TypeScript SDK uses.

Track progress at `adcontextprotocol/adcp-python-server#1` (RFC adoption + scaffold).
