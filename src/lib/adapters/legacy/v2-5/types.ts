/**
 * Registry pattern for v3 ↔ v2.5 wire adapters.
 *
 * Each AdCP tool that needs version translation gets its own
 * `AdapterPair<...>`: a request-side `adaptRequest` (v3 → v2.5 wire shape)
 * and an optional response-side `normalizeResponse` (v2.5 wire → v3
 * surface). Pairs live in per-tool modules under this directory and the
 * registry collects them by tool name.
 *
 * **Why a registry**: before, the four request adapters and the four
 * response normalizers lived across three files (`pricing-adapter.ts`,
 * `creative-adapter.ts`, `sync-creatives-adapter.ts`). Adding v2.6 or
 * v3.1 would mean touching all three plus the dispatch switch in
 * `SingleAgentClient`. The registry collapses that to "drop a new file
 * with a typed `AdapterPair`, register it" — a clean (from, to, tool)
 * triple matches the compatibility-matrix mental model.
 *
 * The current cut wraps the existing scattered adapter functions
 * unchanged so we can ship the registry shape without regressions; the
 * underlying logic stays in `utils/*-adapter.ts` files until each pair
 * gets a focused per-tool refactor.
 */

export interface AdapterPair<TReq3 = unknown, TReq25 = unknown, TRes25 = unknown, TRes3 = unknown> {
  /** AdCP tool name this pair handles (snake_case, e.g. `get_products`). */
  readonly toolName: string;

  /**
   * v3-shaped request → v2.5 wire shape. Called by
   * `SingleAgentClient.adaptRequestForServerVersion` when the agent is
   * v2-detected. May throw for inputs the v2 wire can't represent
   * (e.g. proposal-mode `create_media_buy` without packages).
   */
  adaptRequest(req: TReq3): TReq25;

  /**
   * v2.5-shaped response → v3 surface. Optional — if absent, the response
   * is passed through unchanged. Called by
   * `SingleAgentClient.normalizeResponseToV3` after the executor returns.
   */
  normalizeResponse?(res: TRes25): TRes3;
}
