// prettier-ignore
import { AdcpError, createAdcpServerFromPlatform, createIdempotencyStore, createInMemoryTaskRegistry,
  definePlatform, memoryBackend, proposalTermsDigest, serve, verifyApiKey, type BuyProductsPayload,
  type GetMediaBuysPayload, type ListProductsPayload } from '@adcp/sdk/server';
const TOKEN = process.env.ADCP_AUTH_TOKEN;
if (!TOKEN) throw new Error('Set ADCP_AUTH_TOKEN before starting the seller');
const ACCOUNT_ID = process.env.ADCP_ACCOUNT_ID;
if (!ACCOUNT_ID) throw new Error('Set ADCP_ACCOUNT_ID before starting the seller');
type Product = NonNullable<ListProductsPayload['products']>[number];
const products = parseProducts(process.env.PRODUCT_CATALOG_JSON ?? '[]');
const feedVersion = process.env.PRODUCT_FEED_VERSION ?? 'local-catalog-v1';
type StoredMediaBuy = GetMediaBuysPayload['media_buys'][number];
type AvailableActions = { task: 'control_media_buy'; action: 'pause' | 'resume'; mode: 'self_serve' }[];
// prettier-ignore
type StoredRecord = { accountId: string; requestDigest: string; response: BuyProductsPayload & { status: 'completed' }; buy: StoredMediaBuy };
const buys = new Map<string, StoredRecord>();
const platform = definePlatform({
  // prettier-ignore
  capabilities: { specialisms: ['sales-non-guaranteed'] as const, channels: ['display'] as const,
    pricingModels: ['cpm'] as const, creative_agents: [], config: {} },
  accounts: {
    resolution: 'explicit',
    resolve: async (ref, ctx) => {
      if (!ref || !('account_id' in ref) || ctx?.authInfo?.clientId !== ACCOUNT_ID || ref.account_id !== ACCOUNT_ID) {
        return null;
      }
      // prettier-ignore
      return { id: ACCOUNT_ID, name: ACCOUNT_ID, status: 'active', operator: 'seller.example', ctx_metadata: {} };
    },
  },
  statusMappers: {},
  mediaBuyLifecycle: {
    // prettier-ignore
    listProducts: async (_req, ctx) => ({ outcome: 'listed', products, feed_version: feedVersion,
      cache_scope: ctx.account ? 'account' : 'public' }),
    // prettier-ignore
    buyProducts: async (req, ctx) => {
      if (req.feed_version !== feedVersion) throw new AdcpError('CONFLICT', { message: 'Product feed changed; call list_products again' });
      if (!req.brand) throw new AdcpError('INVALID_REQUEST', { message: 'This starter requires brand' });
      const unsupportedTop = ['pricing_version', 'governance_context', 'reporting_webhook', 'opportunity', 'daily_budget_cap', 'budget_cap_timezone', 'budget_allocation', 'pacing', 'bidding', 'ext'].find(field => field in req);
      if (unsupportedTop) throw new AdcpError('UNSUPPORTED_FEATURE', { message: `${unsupportedTop} is not supported`, field: unsupportedTop });
      for (const [index, purchase] of req.purchases.entries()) {
        const product = products.find(candidate => candidate.product_id === purchase.product_id);
        if (!product) throw new AdcpError('PRODUCT_NOT_FOUND', { message: 'Product not found' });
        if (!product.pricing_options?.some(option => option.pricing_option_id === purchase.pricing_option_id))
          throw new AdcpError('INVALID_PRICING_OPTION', { message: 'Pricing option not found' });
        if (typeof purchase.budget !== 'number') throw new AdcpError('INVALID_REQUEST', { message: 'Every purchase needs a budget' });
        const unsupported = ['format_option_refs', 'catalog_ids', 'daily_budget_cap', 'min_spend_target', 'impressions', 'pacing', 'bidding', 'targeting_overlay', 'optimization_goals', 'audience_evidence_requirements', 'audience_evidence_pins', 'agency_estimate_number', 'ext'].find(field => field in purchase);
        if (unsupported) throw new AdcpError('UNSUPPORTED_FEATURE', { message: `${unsupported} is not supported`, field: `purchases[${index}].${unsupported}` });
        const pricing = product.pricing_options.find(option => option.pricing_option_id === purchase.pricing_option_id)!;
        if (purchase.pricing !== undefined && !sameTerms(purchase.pricing, pricing)) throw new AdcpError('TERMS_REJECTED', { message: 'pricing must match the published offer', field: `purchases[${index}].pricing` });
      }
      const currencies = new Set(req.purchases.map(purchase => products.find(product => product.product_id === purchase.product_id)!.pricing_options!.find(option => option.pricing_option_id === purchase.pricing_option_id)!.currency));
      if (currencies.size !== 1) throw new AdcpError('TERMS_REJECTED', { message: 'All purchases must use one currency', field: 'purchases' });
      const currency = [...currencies][0]!;
      if (req.total_budget && req.total_budget.currency !== currency) throw new AdcpError('TERMS_REJECTED', { message: 'total_budget currency must match purchase pricing', field: 'total_budget.currency' });
      const purchaseBudget = req.purchases.reduce((sum, purchase) => sum + purchase.budget!, 0);
      if (req.total_budget && req.total_budget.amount !== purchaseBudget) throw new AdcpError('TERMS_REJECTED', { message: 'Fixed total_budget must equal the purchase budget sum', field: 'total_budget.amount' });
      const requestDigest = proposalTermsDigest(req);
      const mediaBuyId = `buy_${proposalTermsDigest({ account_id: ctx.account.id, key: req.idempotency_key })}`;
      const existing = buys.get(mediaBuyId);
      if (existing) {
        if (existing.requestDigest !== requestDigest) throw new AdcpError('CONFLICT', { message: 'Idempotency key reused' });
        return existing.response;
      }
      const proposalId = crypto.randomUUID();
      const acceptedAt = new Date().toISOString();
      const resolvedStart = req.start_time === 'asap' ? acceptedAt : req.start_time;
      const commercialTerms = {
        source_feed_version: feedVersion,
        brand: req.brand,
        ...(req.advertiser_industry && { advertiser_industry: req.advertiser_industry }),
        start_time: req.start_time,
        end_time: req.end_time,
        purchases: req.purchases.map(purchase => {
          const product = products.find(candidate => candidate.product_id === purchase.product_id)!;
          const pricing = product.pricing_options!.find(option => option.pricing_option_id === purchase.pricing_option_id)!;
          const published = publishedPurchaseTerms(product);
          if ((purchase.start_time && purchase.start_time !== resolvedStart) || (purchase.end_time && purchase.end_time !== req.end_time)) throw new AdcpError('TERMS_REJECTED', { message: 'Purchase flight must match the media buy flight' });
          for (const field of ['measurement_terms', 'performance_standards'] as const) {
            if (purchase[field] !== undefined && !sameTerms(purchase[field], published[field])) throw new AdcpError('TERMS_REJECTED', { message: `${field} must match the published product terms` });
          }
          return { ...purchase, pricing, ...published, start_time: resolvedStart, end_time: req.end_time };
        }),
        ...(req.total_budget && { total_budget: req.total_budget }),
        ...(req.invoice_recipient && { invoice_recipient: req.invoice_recipient }),
        ...(req.purchase_order_ref && { purchase_order_ref: req.purchase_order_ref }),
        ...(req.agency_estimate_number && { agency_estimate_number: req.agency_estimate_number }),
      };
      const termsDigest = proposalTermsDigest(commercialTerms);
      // prettier-ignore
      const acceptedProposal = { proposal_id: proposalId, proposal_kind: 'new_media_buy' as const,
        proposal_status: 'accepted' as const, name: `Direct purchase ${mediaBuyId}`, commercial_terms: commercialTerms,
        terms_digest: termsDigest, media_buy_id: mediaBuyId, accepted_at: acceptedAt };
      // prettier-ignore
      const bindings = req.purchases.map((purchase, index) => ({ purchase_index: index,
        product_id: purchase.product_id, package_id: crypto.randomUUID() }));
      const totalBudget = req.total_budget?.amount ?? purchaseBudget;
      const initialStatus = req.paused ? 'paused' : 'active';
      // prettier-ignore
      const response: StoredRecord['response'] = { status: 'completed', media_buy_id: mediaBuyId, media_buy_status: initialStatus,
        revision: 1, accepted_proposal: acceptedProposal, purchase_bindings: bindings, available_actions: availableActions(initialStatus) };
      // prettier-ignore
      const record: StoredRecord = { accountId: ctx.account.id, requestDigest, response, buy: {
        media_buy_id: mediaBuyId,
        account: { account_id: ctx.account.id, name: ctx.account.name ?? ctx.account.id, status: 'active' },
        accepted_proposal_id: proposalId, accepted_proposal_terms_digest: termsDigest,
        accepted_proposal: acceptedProposal, status: initialStatus, revision: 1, currency, total_budget: totalBudget,
        start_time: resolvedStart, end_time: req.end_time,
        confirmed_at: acceptedAt, ...(req.context && { context: req.context }),
        packages: bindings.map((binding, index) => ({ package_id: binding.package_id,
          product_id: binding.product_id, budget: req.purchases[index]!.budget ?? 0,
          ...(req.purchases[index]!.context && { context: req.purchases[index]!.context }) })),
        available_actions: availableActions(initialStatus) } };
      buys.set(mediaBuyId, record);
      return response;
    },
    // prettier-ignore
    controlMediaBuy: async (req, ctx) => {
      const stored = buys.get(req.media_buy_id);
      if (!stored || stored.accountId !== ctx.account.id) throw new AdcpError('MEDIA_BUY_NOT_FOUND', { message: 'Media buy not found' });
      const buy = stored.buy;
      if (buy.revision !== req.revision) throw new AdcpError('CONFLICT', { message: 'Revision is stale' });
      if (buy.status === 'canceled') throw new AdcpError(req.canceled === true ? 'NOT_CANCELLABLE' : 'INVALID_STATE', { message: 'Canceled' });
      if ('reporting_webhook' in req) throw new AdcpError('UNSUPPORTED_FEATURE', { message: 'reporting_webhook control is unsupported', field: 'reporting_webhook' });
      if ('name' in req) throw actionNotAllowed('update_name', 'not_supported_on_buy', buy);
      const unsupported = 'total_budget,daily_budget_cap,budget_cap_timezone,budget_allocation,pacing,bidding,packages'.split(',').find(field => field in req);
      if (unsupported) throw new AdcpError('REQUOTE_REQUIRED', { message: `${unsupported} requires a new proposal`, details: { envelope_field: unsupported } });
      const action = req.canceled === true ? 'cancel' : req.paused === true ? 'pause' : req.paused === false ? 'resume' : null;
      if (action && !availableActions(buy.status).some(available => available.action === action)) throw actionNotAllowed(action, action === 'cancel' ? 'not_supported_on_buy' : 'wrong_status', buy);
      if (!action) return { status: 'completed', media_buy_id: buy.media_buy_id, media_buy_status: buy.status, revision: buy.revision, available_actions: availableActions(buy.status) };
      buy.revision += 1;
      if (req.canceled === true) buy.status = 'canceled';
      else if (req.paused !== undefined) buy.status = req.paused ? 'paused' : 'active';
      const available_actions = availableActions(buy.status);
      buy.available_actions = available_actions;
      // prettier-ignore
      return { status: 'completed', media_buy_id: buy.media_buy_id, media_buy_status: buy.status,
        revision: buy.revision, available_actions };
    },
    getMediaBuys: async (req, ctx) => ({
      media_buys: (req.media_buy_ids ? req.media_buy_ids.flatMap(id => buys.get(id) ?? []) : [...buys.values()])
        .filter(stored => stored.accountId === ctx.account.id)
        .map(stored => stored.buy),
    }),
    getMediaBuyDelivery: async req => ({
      status: 'completed',
      // prettier-ignore
      reporting_period: { start: req.start_date ?? new Date().toISOString().slice(0, 10),
        end: req.end_date ?? new Date().toISOString().slice(0, 10) },
      media_buy_deliveries: [],
    }),
  },
});
const taskRegistry = createInMemoryTaskRegistry();
const idempotency = createIdempotencyStore({ backend: memoryBackend(), ttlSeconds: 86_400 });
if (process.env.ADCP_EXAMPLE_CHECK !== '1') {
  // prettier-ignore
  serve(
    () => createAdcpServerFromPlatform(platform, { name: 'AdCP 3.2 seller starter', version: '1.0.0',
      taskRegistry, idempotency }),
    { port: Number(process.env.PORT ?? 3000), authenticate: verifyApiKey({ keys: { [TOKEN]: { principal: ACCOUNT_ID } } }) });
}
function parseProducts(raw: string): Product[] {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error('PRODUCT_CATALOG_JSON must be a JSON array');
  return value as Product[];
}
// prettier-ignore
function availableActions(status: StoredMediaBuy['status']): AvailableActions {
  if (status === 'canceled') return [];
  const action = (name: 'pause' | 'resume') => ({ task: 'control_media_buy', action: name, mode: 'self_serve' }) as const;
  return [action(status === 'paused' ? 'resume' : 'pause')];
}
// prettier-ignore
function actionNotAllowed(action: string, reason: string, buy: StoredMediaBuy) {
  return new AdcpError('ACTION_NOT_ALLOWED', { message: `${action} is not available while ${buy.status}`,
    details: { attempted_action: action, reason, currently_available_actions: availableActions(buy.status) } });
}
// prettier-ignore
function canonicalBrand(ref: { domain: string; brand_id?: string; countries?: string[] }) {
  return { domain: ref.domain, ...(ref.brand_id && { brand_id: ref.brand_id }), ...(ref.countries && { countries: [...ref.countries].sort() }) };
}
// prettier-ignore
function publishedPurchaseTerms(product: Product) {
  const measurement = product.measurement_terms, billing = measurement?.billing_measurement;
  const measurement_terms = measurement && {
    ...(billing && { billing_measurement: { vendor: canonicalBrand(billing.vendor),
      ...(billing.max_variance_percent !== undefined && { max_variance_percent: billing.max_variance_percent }),
      ...(billing.measurement_window && { measurement_window: billing.measurement_window }),
      ...(billing.finalization_deadline_hours !== undefined && { finalization_deadline_hours: billing.finalization_deadline_hours }) } }),
    ...(measurement.makegood_policy && { makegood_policy: { available_remedies: [...measurement.makegood_policy.available_remedies] } }),
  };
  const performance_standards = product.performance_standards?.map(term => ({ metric: term.metric,
    threshold: term.threshold, vendor: canonicalBrand(term.vendor), ...(term.standard && { standard: term.standard }) }));
  return { ...(measurement_terms && { measurement_terms }), ...(performance_standards && { performance_standards }) };
}
// prettier-ignore
function sameTerms(left: unknown, right: unknown) { return proposalTermsDigest({ terms: left }) === proposalTermsDigest({ terms: right }); }
