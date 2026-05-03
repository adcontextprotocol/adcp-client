---
name: build-si-agent
description: Use when building an AdCP sponsored intelligence agent — a brand-side conversational AI experience that an LLM host (ChatGPT, Claude, Perplexity, Arc) can hand off to.
---

# Build a Sponsored Intelligence Agent

A sponsored intelligence (SI) agent runs a brand-side conversational AI experience that an LLM host can hand off to. The buyer agent calls four tools across the session lifecycle:

1. `si_get_offering` — discover what's available, get an `offering_token`
2. `si_initiate_session` — start a conversation, receive `session_id`
3. `si_send_message` — exchange turns, optionally surface a handoff hint
4. `si_terminate_session` — end the session, optionally return ACP checkout payload

The agent owns the brand voice, transcript state, and product knowledge. The host owns the user, identity consent, and ACP checkout. SI is the AdCP surface that connects them.

## Pick your fork target

| Protocol | Fork this | Storyboard |
| --- | --- | --- |
| `sponsored-intelligence` | [`hello_si_adapter_brand.ts`](../../examples/hello_si_adapter_brand.ts) | `si_baseline` |

SI is a **protocol** in AdCP 3.0, not a specialism. Declare it via the `sponsoredIntelligence` field on the v6 `DecisioningPlatform`; the framework auto-derives `'sponsored_intelligence'` into `supported_protocols` from the four registered SI tools. There's no `specialisms: ['sponsored-intelligence']` claim today (tracked at adcontextprotocol/adcp#3961 for 3.1).

The storyboard at `compliance/cache/latest/protocols/sponsored-intelligence/index.yaml` has three phases (capability_discovery, offering_discovery, session_lifecycle) covering all four tools. The reference adapter passes 3/3.

For exact response shapes, error codes, and optional fields, `docs/llms.txt` is the canonical reference.

## When to use this skill

- User wants to build a brand-agent platform that hosts conversational ads (Salesforce Agentforce, OpenAI Assistants brand mode, custom in-house brand chat)
- User mentions sponsored intelligence, SI sessions, conversational ads, brand handoff, or ACP checkout
- User references `si_initiate_session`, `si_send_message`, `si_get_offering`, or `si_terminate_session`

**Not this skill:**

- Selling display/video inventory → `skills/build-seller-agent/`
- Serving audience segments → `skills/build-signals-agent/`
- Managing creatives → `skills/build-creative-agent/`
- Brand identity + rights licensing → `skills/build-brand-rights-agent/`

## Cross-cutting rules

Every SI agent hits the cross-cutting rules in [`../cross-cutting.md`](../cross-cutting.md). One SI-specific note on idempotency:

`si_initiate_session` and `si_send_message` are mutating and require `idempotency_key`. `si_terminate_session` is naturally idempotent on `session_id` and intentionally lacks the key (re-terminating a closed session must return the same payload). `si_get_offering` is read-only.

## Specialism deltas at a glance

**`sponsored-intelligence` protocol** —

- **Single brand per deployment is typical** — one Agentforce instance per advertiser, one OpenAI Assistant per brand. Multi-brand variants route via per-API-key tenant binding inside `accounts.resolve`, not by carrying `account` on the wire (SI tool schemas don't have it).
- **Session state**: the framework auto-hydrates a small `req.session` record (intent, offering scoping, identity consent, negotiated capabilities) onto `si_send_message` / `si_terminate_session`. Production brand engines almost always own full transcript state in their own backend (Postgres, Redis, vector store) — full transcripts, RAG embeddings, tool-call logs are too rich for `ctx_metadata` and easily exceed the 16KB blob cap. Treat `req.session` as a convenience, not authoritative state.
- **Offerings**: each represents a sponsored experience — product/brand being sponsored, conversation style (informational/promotional/interactive), modalities (text/voice/video/A2UI), TTL on the `offering_token`.
- **Handoff modes**: `si_terminate_session.reason` is a closed enum — `user_exit | session_timeout | host_terminated | handoff_transaction | handoff_complete`. `handoff_transaction` returns `acp_handoff` with `checkout_url`, `checkout_token`, `expires_at`; `handoff_complete` is conversation-concluded-naturally with no checkout.

## Common shape gotchas

- **Field is `session_status`, not `status`** — values `'active' | 'pending_handoff' | 'complete' | 'terminated'`. `status: 'active'` fails wire validation.
- **Termination uses boolean `terminated: true`**, not `status: 'terminated'`.
- **`si_send_message` response requires `session_id`** even though it's also in the request — echo from `req.session_id`.
- **`si_get_offering` requires `available: boolean`** at the top level.
- **`reason` enum is closed** — see above. Anything else fails wire validation.
- **`product_card` in `ui_elements` requires `data.title` + `data.price`** (not `name`/`display_price`); `action_button` requires `data.label` + `data.action`. Project per-`type` from upstream vocabulary in your handler.

See [`../SHAPE-GOTCHAS.md`](../SHAPE-GOTCHAS.md).

## Validate locally

```bash
# Run the fork-matrix gate
npm run compliance:fork-matrix -- --test-name-pattern="hello-si-adapter-brand"

# Or validate your forked agent directly against the SI baseline
adcp storyboard run http://127.0.0.1:3007/mcp si_baseline \
  --bearer "$ADCP_AUTH_TOKEN" --include-bundles --json
```

The fork-matrix gate is the three-gate contract from [`docs/guides/EXAMPLE-TEST-CONTRACT.md`](../../docs/guides/EXAMPLE-TEST-CONTRACT.md): tsc strict / storyboard zero-failures / upstream façade.

For deeper validation: [`docs/guides/VALIDATE-YOUR-AGENT.md`](../../docs/guides/VALIDATE-YOUR-AGENT.md).

## Migration notes

- 6.6 → 6.7: SI v6 platform shipped (protocol-keyed dispatch, auto-hydrated session, storyboard 3/3 pass) in 6.7. See [`docs/migration-6.6-to-6.7.md`](../../docs/migration-6.6-to-6.7.md).
- 4.x → 5.x: A2A session continuity + typed errors landed in 5.9. See [`docs/migration-4.x-to-5.x.md`](../../docs/migration-4.x-to-5.x.md).
