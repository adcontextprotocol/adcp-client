/** Discovery and negotiation must never invent an unprovisioned account. */
export const ACCOUNT_FREE_DISCOVERY_TASKS: ReadonlySet<string> = new Set([
  'get_products',
  'list_products',
  'get_signals',
  'request_proposals',
  'refine_proposals',
  'decline_proposals',
]);
