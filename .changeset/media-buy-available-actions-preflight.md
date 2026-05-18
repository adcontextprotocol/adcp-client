---
'@adcp/sdk': minor
---

feat(media-buy): buyer-side preflight helpers for `available_actions[]` (AdCP 3.1 / RFC #4480)

Adds the consumer surface for [adcontextprotocol/adcp#4480](https://github.com/adcontextprotocol/adcp/issues/4480) (merged in adcontextprotocol/adcp#4514) so buyer agents don't have to hand-roll capability checks against `update_media_buy`.

Three layers, each usable on its own:

- **Boolean gates** on the buy: `canPause`, `canResume`, `canCancel`, `canExtendFlight`, `canShortenFlight`, `canUpdateFlightDates`, `canIncreaseBudget`, `canDecreaseBudget`, `canReallocateBudget`, `canUpdateTargeting`, `canUpdatePacing`, `canUpdateFrequencyCaps`, `canReplaceCreative`, `canUpdateCreativeAssignments`, `canRemoveCreative`, `canAddPackages`, `canRemovePackages`. Each reads `available_actions[]` (or rolls up from legacy `valid_actions[]`) and returns whether the action is reachable. Drives UI affordances without an extra round-trip.

- **Resolver**: `getActionForMutation(currentBuy, request)` walks the request body and returns the fine-grained actions it covers as a `ResolvedAction[]`. Direction inference picks `increase_budget` vs `decrease_budget` vs `reallocate_budget` from the per-package budget diff, and `extend_flight` vs `shorten_flight` vs `update_flight_dates` from the start/end-time diff. The action-to-field mapping is read from `enumMetadata.update_fields` in the schema rather than hand-copied; regenerate via `scripts/generate-media-buy-update-fields.ts` on a schema bump.

- **Preflight**: `preflightUpdateMediaBuy(currentBuy, request)` composes the resolver and the gates into a discriminated union: `{ ok: true, actions[], modes[], matched[], requiresAsyncFlow, compat? }` or `{ ok: false, action, reason, currently_available_actions, recovery?, compat? }`. Callers decide whether to fire the network request, or branch on the mode (`self_serve` vs `requires_proposal` vs `requires_approval`) to pick the right flow.

Typed error surface:

- **`ActionNotAllowedError`** new error class on `@adcp/sdk` with `attemptedAction`, `reason` (`wrong_status` | `not_supported_on_product` | `not_supported_on_buy` | `mode_mismatch`), `currentlyAvailableActions[]`, and a typed `recovery` hint (`createProposal` / `waitForApproval` / `reissueAsDirect`) populated for `mode_mismatch`. Wired into `adcpErrorToTypedError()` with permissive parsing of the upstream `details` payload (rejects unknown reasons / malformed available-action entries rather than throwing).

Compat shim:

- `getAvailableActions(buy)` reads `available_actions[]` when present, falls back to synthesizing from `valid_actions[]` with `mode: 'self_serve'`. Returns `{ source: 'available_actions' | 'valid_actions' | 'absent' }` and a `deprecationHint` when only the legacy field was populated. One-shot `console.warn` per process, suppressible via `{ silent: true }`. `findAvailableAction(buy, action)` honors `enumMetadata.rollup` so a fine-grained gate matches a seller's legacy coarse emission (e.g. `canIncreaseBudget` returns true when the seller advertises `update_budget`).

Types are hand-written in `src/lib/media-buy/types.ts` until the next schema-cache bump pulls the AdCP 3.1 sources into `*.generated.ts`; the module index re-exports them from a single import path.
