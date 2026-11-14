---
'@adcp/sdk': minor
---

New `resolvePublisherSigningKeyPin(adAgents, agentUrl, { adcpVersion, at, country, propertyIds })` computes a publisher's `signing_keys` pin for one signed message. This is the SDK side of adcontextprotocol/adcp#9016.

Under AdCP 3.3 more than one `authorized_agents[]` entry can match one agent, for example an origin-only entry next to the agent's full URL. Only entries that match the agent and authorize the message's scope count. Such an entry:

- resolves to something, so an unresolvable or signals-only entry does not count;
- is inside its `effective_from` / `effective_until` window;
- covers the country and each requested property.

An entry that authorizes nothing for the message never pins or unpins it.

Among the entries that count:

- The publisher pins the agent only if every one carries `signing_keys`; one with none (absent or empty) means no pin.
- Otherwise the result is the union of their keys. A key repeated identically appears once, and copies that differ in `revoked_at` are all kept, so the earliest revocation applies whatever the entry order.
- With `propertyIds`, each property gets its own pin and the result keeps only the keys every pinned property allows.

What it returns:

- `undefined` when the publisher does not pin the agent for the message.
- `[]`, which `PublisherSigningKeyPin` reads as "accept no key", when the agent is not authorized for the message: not listed, ambiguous below 3.3, no entry covering the scope, or a property no entry covers. So it drops into `PublisherSigningKeyPin.signingKeys`, and `?? null` gives a `refresh` result.
- The publisher's own pin when one exact entry matches, as below 3.3.

It is exported from `@adcp/sdk` and `@adcp/sdk/discovery`, with the `PublisherSigningKeyPinOptions` type.

The SDK makes no pin decision from `adagents.json` itself: webhook `publisherPins` are supplied by the caller, and supply-path verification only lists `signing_keys` as an understood field. So no existing behaviour changes.

Other changes:

- `AuthorizedAgent` gains optional `signing_keys`, `countries`, `effective_from` and `effective_until`.
- The `matched_entries` and `AgentDirectoryPublisher.signing_keys_pinned` docs now state the rule. The directory flag is a scope-agnostic summary.
- This supersedes the 17.0.0-beta note that the AAO registry reports keys as pinned when any matching entry pins one.
