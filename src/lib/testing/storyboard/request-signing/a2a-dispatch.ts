/**
 * A2A dispatch for request-signing vectors, through the OFFICIAL client.
 *
 * ## Why this exists, and why it is not a third hand-written binding
 *
 * RFC 9421 grading needs two things that pull against each other: the request
 * must be the one a real buyer's stack emits (or the grade says nothing about
 * interop), and the signature must cover the EXACT bytes that go on the wire
 * (or the verifier reconstructs a different signature base and every vector
 * fails for the wrong reason).
 *
 * Hand-building an A2A envelope satisfies the second and forfeits the first:
 * the method name, the proto-JSON enum spellings, the payload key and the
 * version header all become this file's guesses about a protocol it does not
 * own. That is the objection that closed adcp-client#2964, and it was a fair
 * one.
 *
 * So this module does neither. It drives `@a2a-js/sdk`'s own `ClientFactory`
 * and intercepts at the SDK's own `fetchImpl` seam — the request captured
 * there is the one the official client built and was about to send, byte for
 * byte. We sign those bytes and hand them to the existing hardened probe.
 *
 * What the SDK decides, and this file therefore never writes down:
 *
 * | decision              | who makes it                                  |
 * |-----------------------|-----------------------------------------------|
 * | endpoint              | the agent card's `supportedInterfaces[]`      |
 * | JSON-RPC method name  | the SDK, per the card's `protocolVersion`     |
 * | `a2a-version` header  | the SDK, from that same version               |
 * | proto-JSON encoding   | the SDK (`role` → `"ROLE_USER"`, not `1`)     |
 * | payload key           | the SDK (`input` on 1.x, `parameters` on 0.x) |
 *
 * That table is the whole argument. Observed, not assumed — against a card
 * declaring `1.0` the client emits `{"method":"SendMessage",...}` with
 * `a2a-version: 1.0`; against `0.3.0` it emits `{"method":"tasks/cancel",...}`
 * with `a2a-version: 0.3` for the same `cancelTask` call.
 *
 * ## The version header is inside the signature base, not added after it
 *
 * Capture happens BEFORE signing. `a2a-version` is therefore part of the
 * request the signer sees, which is the only ordering that works: the verifier
 * reconstructs the base from the headers it received, so a header appended
 * after signing sits outside the base the signer computed.
 *
 * ## Peer dependency
 *
 * `@a2a-js/sdk` is a peer dependency. The import is dynamic and lives inside
 * the A2A path, so grading an MCP agent never loads it and an adopter grading
 * MCP is never required to install it.
 */

/**
 * A request the official A2A client produced: everything needed to sign it and
 * put it on the wire, and nothing this module invented.
 */
export interface CapturedA2aRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * What to ask the official client for.
 *
 * `sendMessage` carries an AdCP operation invocation — the shape every
 * tool-targeting vector needs. `cancelTask` is the native task-lifecycle call
 * that vector 028 (`protocol_methods_required_for`) grades; naming it here
 * rather than framing a body means the SDK picks the method string for the
 * card's declared version (`tasks/cancel` on 0.3, `CancelTask` on 1.0), which
 * is the distinction the seller's `protocol_methods_*` declaration is made
 * against.
 */
export type A2aCall =
  | { kind: 'sendMessage'; operation: string; args: Record<string, unknown> }
  | { kind: 'cancelTask'; taskId: string };

/** Thrown by the capturing `fetchImpl` to unwind once the request exists. */
class RequestCaptured extends Error {
  constructor(readonly captured: CapturedA2aRequest) {
    super('a2a request captured');
  }
}

export interface A2aDispatchOptions {
  /** Abort budget for the card fetch, in milliseconds. */
  timeoutMs?: number;
  /**
   * Injected for tests. Production passes nothing and the SDK's own default
   * `fetch` performs the card fetch.
   */
  cardFetch?: typeof fetch;
}

/**
 * Drive the official client for *call* and return the request it emitted.
 *
 * The client is constructed per call rather than cached: `ClientFactory`
 * resolves the agent card during construction, and a vector run that reused
 * one client across vectors would be grading against a card snapshot taken
 * before the run rather than the agent as it stands. The card fetch is one
 * request against an endpoint the run is already dialling.
 */
export async function captureA2aRequest(
  agentUrl: string,
  call: A2aCall,
  options: A2aDispatchOptions = {}
): Promise<CapturedA2aRequest> {
  const { ClientFactory, JsonRpcTransportFactory } = await import('@a2a-js/sdk/client');

  const capturingFetch: typeof fetch = async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
    throw new RequestCaptured({
      url: request.url,
      method: request.method,
      headers,
      body: await request.text(),
    });
  };

  // The card fetch must NOT go through the capturing fetch — that fetch exists
  // to intercept the graded request, and swallowing the card fetch with it
  // would leave the factory with no card at all. `cardFetch` is the test seam;
  // production leaves it unset so the SDK uses its own default.
  const factory = new ClientFactory({
    transports: [
      new JsonRpcTransportFactory({
        fetchImpl: capturingFetch,
        // A card declaring 0.3.x selects the legacy transport, whose method
        // strings are the `tasks/*` family the AdCP spec names
        // (security.mdx @ 3.1.1 :1045 cites "A2A 0.3.0 §7.x"). Without this the
        // client would refuse a 0.3 card outright and the vectors would be
        // unavailable for a version the spec explicitly covers.
        legacyCompat: { enabled: true },
      }),
    ],
    ...(options.cardFetch ? { cardResolver: await buildCardResolver(options.cardFetch) } : {}),
  });

  const client = await factory.createFromUrl(agentUrl);

  try {
    if (call.kind === 'cancelTask') {
      await client.cancelTask({ tenant: '', id: call.taskId, metadata: undefined } as never);
    } else {
      await client.sendMessage({
        tenant: '',
        message: {
          messageId: cryptoRandomId(),
          // `1` is `Role.ROLE_USER` in the generated enum; the SDK proto-JSONs
          // it to the string `"ROLE_USER"` on the wire. Writing the string here
          // would be this file guessing at an encoding the SDK owns.
          role: 1,
          parts: [{ content: { $case: 'data', value: { skill: call.operation, input: call.args } } }],
        } as never,
        configuration: undefined as never,
        metadata: undefined as never,
      } as never);
    }
  } catch (err) {
    if (err instanceof RequestCaptured) return err.captured;
    throw err;
  }

  throw new Error(`the A2A client returned without issuing a request for ${call.kind}; nothing was captured to sign`);
}

async function buildCardResolver(cardFetch: typeof fetch) {
  const { DefaultAgentCardResolver } = await import('@a2a-js/sdk/client');
  return new DefaultAgentCardResolver({ fetchImpl: cardFetch });
}

function cryptoRandomId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * The AdCP operation a vector targets, read off its recorded REST URL.
 *
 * Identical derivation to the MCP path's `extractOperationFromVectorUrl`, and
 * deliberately so: both bindings name the operation, and a vector's operation
 * is a property of the vector rather than of the transport carrying it.
 */
export function operationFromVectorUrl(vectorUrl: string): string {
  const segments = new URL(vectorUrl).pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last || !/^[a-z][a-z0-9_]*$/.test(last)) {
    throw new Error(`Cannot extract an AdCP operation name from vector URL: ${vectorUrl}`);
  }
  return last;
}

/**
 * Resolve the agent card and confirm the official client can dispatch to it.
 *
 * Throws when the card does not resolve or declares no interface the SDK's
 * JSONRPC transport can drive. Callers treat that as "no A2A dispatch here"
 * rather than framing a request against a guess.
 */
export async function resolveA2aDispatchTarget(agentUrl: string): Promise<{ endpoint: string }> {
  const { ClientFactory, JsonRpcTransportFactory } = await import('@a2a-js/sdk/client');
  let endpoint = '';
  const noteEndpoint: typeof fetch = async (input, init) => {
    endpoint = new Request(input as RequestInfo, init).url;
    throw new RequestCaptured({ url: endpoint, method: 'POST', headers: {}, body: '' });
  };
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl: noteEndpoint, legacyCompat: { enabled: true } })],
  });
  // `createFromUrl` fetches and normalizes the card and selects the interface;
  // it throws when no transport matches, which IS the availability answer.
  const client = await factory.createFromUrl(agentUrl);
  try {
    await client.cancelTask({ tenant: '', id: 'a2a-dispatch-probe', metadata: undefined } as never);
  } catch (err) {
    if (err instanceof RequestCaptured) return { endpoint };
    throw err;
  }
  return { endpoint };
}
