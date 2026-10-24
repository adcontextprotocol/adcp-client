const CAPS = {
  status: 'completed',
  adcp: { major_versions: [3], supported_versions: ['3.2'], idempotency: { supported: false } },
  supported_protocols: ['media_buy'],
  media_buy: { buying_modes: ['brief', 'wholesale'] },
};
const TOOLS = ['get_adcp_capabilities', 'get_products', 'create_media_buy'];
const ENDPOINT = 'https://prepared-fixtures-test.example/mcp';

function product(id, extra = {}) {
  return {
    product_id: id,
    name: 'Catalog offer',
    description: 'Prepared-state probe offer.',
    publisher_properties: [{ publisher_domain: 'publisher.example', selection_type: 'all' }],
    channels: ['ctv'],
    delivery_type: 'non_guaranteed',
    format_options: [{ format_option_id: 'video', format_kind: 'video_hosted', params: { duration_ms_exact: 30000 } }],
    pricing_options: [
      {
        pricing_option_id: 'seller-price',
        pricing_model: 'cpm',
        currency: 'EUR',
        fixed_price: 24,
        min_spend_per_package: 5000,
      },
    ],
    collections: [{ publisher_domain: 'owner.example', collection_ids: ['news', 'music'] }],
    reporting_capabilities: {
      available_reporting_frequencies: ['daily'],
      expected_delay_minutes: 0,
      timezone: 'UTC',
      supports_webhooks: false,
      available_metrics: ['impressions', 'spend'],
      date_range_support: 'date_range',
    },
    ...extra,
  };
}

function transport(catalog, overrides = {}) {
  // `overrides.transportFailure` makes the fetch itself reject, so a test
  // can exercise the transport arm without a response ever existing.
  if (overrides.transportFailure) {
    const wire = [];
    const calls = [];
    return {
      calls,
      wire,
      options: {
        adcpVersion: '3.2.5',
        timeout_ms: 5000,
        profile: { tools: TOOLS, raw_capabilities: CAPS, supported_protocols: ['media_buy'] },
        transport: {
          trustedFetchFn: async (_input, init = {}) => {
            const message = JSON.parse(init.body);
            wire.push(message.method);
            if (message.method === 'tools/call' && message.params?.name === 'get_products') {
              throw new Error('synthetic transport failure: connection reset');
            }
            return originalTransport(catalog).options.transport.trustedFetchFn(_input, init);
          },
        },
      },
    };
  }
  return originalTransport(catalog, overrides);
}

function originalTransport(catalog, overrides = {}) {
  const calls = [];
  // Every seller endpoint interaction, including official-client
  // initialization and tool discovery — not just the mutating calls. A gate
  // that merely precedes `create_media_buy` is not a gate that precedes
  // seller contact.
  const wire = [];
  const trustedFetchFn = async (_input, init = {}) => {
    // Real network I/O yields; let Response buffers be reclaimed between exchanges.
    await new Promise(resolve => setImmediate(resolve));
    const message = JSON.parse(init.body);
    wire.push(message.method);
    let result;
    if (message.method === 'initialize') {
      result = {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'prepared-fixtures-test', version: '1' },
      };
    } else if (message.method.startsWith('notifications/')) {
      return new Response(null, { status: 202 });
    } else if (message.method === 'tools/list') {
      result = {
        tools: (overrides.tools ?? TOOLS).map(name => ({
          name,
          description: name,
          inputSchema: { type: 'object', additionalProperties: true },
        })),
      };
    } else if (message.method === 'tools/call') {
      const { name, arguments: request } = message.params;
      calls.push({ task: name, request });
      if (name === 'get_products' && overrides.protocolFailure) {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    overrides.protocolPayload ?? {
                      status: 'failed',
                      adcp_error: {
                        code: 'INVALID_REQUEST',
                        message: 'Seller refused discovery',
                        recovery: 'terminal',
                      },
                    }
                  ),
                },
              ],
            },
          }),
          { headers: { 'content-type': 'application/json' } }
        );
      }
      let data;
      if (name === 'get_adcp_capabilities') data = overrides.capabilities?.() ?? CAPS;
      else if (name === 'get_products')
        data = overrides.read?.(request) ?? {
          status: 'completed',
          products: catalog,
          cache_scope: 'account',
          wholesale_feed_version: 'v1',
        };
      else if (name === 'comply_test_controller' && overrides.controller) data = overrides.controller(request);
      else if (name === 'create_media_buy')
        data = {
          status: 'completed',
          media_buy_id: 'seller-buy',
          revision: 1,
          confirmed_at: '2026-10-19T00:00:00Z',
          packages: [],
        };
      else throw new Error(`Unexpected tool ${name}`);
      result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
    } else {
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    calls,
    wire,
    options: {
      adcpVersion: '3.2.5',
      timeout_ms: 5000,
      profile: { tools: TOOLS, raw_capabilities: CAPS, supported_protocols: ['media_buy'] },
      transport: { trustedFetchFn },
    },
  };
}

function board({ steps } = {}) {
  return {
    id: 'prepared_fixtures/selection',
    version: '1.0.0',
    category: 'media_buy_seller',
    title: 'Prepared fixture reuse',
    summary: 'Full and standalone consumers share one preparation.',
    narrative: 'Exercises the public preparation contract.',
    agent: { interaction_model: 'media_buy_seller', capabilities: ['sells_media'] },
    caller: { role: 'buyer_agent' },
    fixtures: {
      products: [product('authored-product', { collection_targeting_allowed: true })],
      pricing_options: [{ product_id: 'authored-product', pricing_option_id: 'authored-price', pricing_model: 'cpm' }],
    },
    fixture_resolution: {
      products: [
        {
          handle: 'authored-product',
          strategies: ['discover'],
          match: [
            {
              path: '',
              operator: 'collection_selection_satisfies',
              value: { collection_targeting: 'selectable', minimum_pairs: 2 },
            },
          ],
          context_outputs: [
            { key: '__adcp_fixture_product_id', path: 'product_id' },
            { key: '__adcp_fixture_subset', witness: 'strict_subset' },
          ],
        },
      ],
      pricing_options: [
        {
          handle: 'authored-price',
          product_handle: 'authored-product',
          strategies: ['discover'],
          match: [{ path: '/pricing_model', operator: 'equals', value: 'cpm' }],
          context_outputs: [
            { key: '__adcp_fixture_currency', path: 'currency' },
            { key: '__adcp_fixture_min_spend', path: 'min_spend_per_package' },
          ],
        },
      ],
    },
    phases: [
      {
        id: 'exercise',
        title: 'Exercise',
        steps: steps ?? [
          {
            id: 'create',
            title: 'Buy the pinned offer',
            task: 'create_media_buy',
            stateful: true,
            sample_request: {
              brand: { domain: 'acmeoutdoor.example' },
              start_time: 'asap',
              end_time: '2099-06-30T23:59:59Z',
              currency: '$context.__adcp_fixture_currency',
              packages: [
                {
                  product_id: '$context.__adcp_fixture_product_id',
                  pricing_option_id: 'authored-price',
                  budget: '$context.__adcp_fixture_min_spend',
                  targeting_overlay: {
                    collection_selection: { mode: 'selected', collections: '$context.__adcp_fixture_subset' },
                  },
                },
              ],
            },
            validations: [{ check: 'field_present', path: 'media_buy_id', description: 'The buy succeeds' }],
          },
        ],
      },
    ],
  };
}

const SELECTED = product('a-selected', { collection_targeting_allowed: true });
module.exports = { CAPS, TOOLS, ENDPOINT, product, transport, board, SELECTED };
