import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  COHORTS,
  DEFAULT_API_KEY,
  DESTINATIONS,
  OPERATORS,
  type MockCohort,
  type MockDestination,
  type MockOperator,
  type MockPricingTier,
} from './seed-data';

export interface BootOptions {
  port: number;
  apiKey?: string;
  /** Override seed cohorts. Defaults to fixture data. */
  cohorts?: MockCohort[];
  destinations?: MockDestination[];
  operators?: MockOperator[];
}

export interface BootResult {
  url: string;
  close: () => Promise<void>;
}

export async function bootSignalMarketplace(options: BootOptions): Promise<BootResult> {
  const apiKey = options.apiKey ?? DEFAULT_API_KEY;
  const cohorts = options.cohorts ?? COHORTS;
  const destinations = options.destinations ?? DESTINATIONS;
  const operators = options.operators ?? OPERATORS;

  // Activations live in memory. Keyed by activation_id; cross-checked against
  // operator_id on read so cross-tenant leakage shows up as 403.
  const activations = new Map<string, MockActivation>();
  // client_request_id idempotency table — keyed by `<operator_id>::<client_request_id>`
  // so two operators can use the same client_request_id and not collide.
  const idempotency = new Map<string, string>();

  const server = createServer((req, res) => {
    handleRequest(req, res, {
      apiKey,
      cohorts,
      destinations,
      operators,
      activations,
      idempotency,
    }).catch(err => {
      // Defense-in-depth — handlers should never throw, but if one does we
      // emit a 500 with a request_id so adopter logs can still trace it.
      const requestId = req.headers['x-request-id'] as string | undefined ?? randomUUID();
      writeJson(res, 500, {
        code: 'internal_error',
        message: err?.message ?? 'unexpected error',
        request_id: requestId,
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  // Use the actually-bound port. Caller may pass 0 to request an OS-assigned
  // free port (test convenience); reading address() gives the truth either way.
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : options.port;
  const url = `http://127.0.0.1:${boundPort}`;
  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
      }),
  };
}

interface HandlerCtx {
  apiKey: string;
  cohorts: MockCohort[];
  destinations: MockDestination[];
  operators: MockOperator[];
  activations: Map<string, MockActivation>;
  idempotency: Map<string, string>;
}

interface MockActivation {
  activation_id: string;
  operator_id: string;
  cohort_id: string;
  destination_id: string;
  pricing_id: string;
  status: 'pending' | 'in_progress' | 'active' | 'failed' | 'expired';
  match_rate?: number;
  member_count_matched?: number;
  platform_segment_id?: string;
  agent_activation_key?: Record<string, string>;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx): Promise<void> {
  // Authentication first. Order matters — surface bad-credential errors before
  // operator/cohort lookups so adopters can debug auth in isolation.
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== ctx.apiKey) {
    writeJson(res, 401, { code: 'unauthorized', message: 'Missing or invalid bearer credential.' });
    return;
  }

  const operatorHeader = req.headers['x-operator-id'];
  const operatorId = Array.isArray(operatorHeader) ? operatorHeader[0] : operatorHeader;
  if (!operatorId) {
    writeJson(res, 403, {
      code: 'operator_required',
      message: 'X-Operator-Id header is required on every request.',
    });
    return;
  }
  const operator = ctx.operators.find(o => o.operator_id === operatorId);
  if (!operator) {
    writeJson(res, 403, {
      code: 'unknown_operator',
      message: `Unknown operator: ${operatorId}`,
    });
    return;
  }

  const url = new URL(req.url ?? '/', `http://127.0.0.1`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // GET /v2/cohorts
  if (method === 'GET' && path === '/v2/cohorts') {
    return handleListCohorts(url, ctx, operator, res);
  }
  // GET /v2/cohorts/{id}
  const cohortMatch = path.match(/^\/v2\/cohorts\/([^/]+)$/);
  if (method === 'GET' && cohortMatch && cohortMatch[1]) {
    return handleGetCohort(decodeURIComponent(cohortMatch[1]), ctx, operator, res);
  }
  // GET /v2/destinations
  if (method === 'GET' && path === '/v2/destinations') {
    return handleListDestinations(ctx, operator, res);
  }
  // POST /v2/activations
  if (method === 'POST' && path === '/v2/activations') {
    return handleCreateActivation(req, ctx, operator, res);
  }
  // GET /v2/activations/{id}
  const activationMatch = path.match(/^\/v2\/activations\/([^/]+)$/);
  if (method === 'GET' && activationMatch && activationMatch[1]) {
    return handleGetActivation(decodeURIComponent(activationMatch[1]), ctx, operator, res);
  }

  writeJson(res, 404, { code: 'not_found', message: `No route for ${method} ${path}` });
}

function handleListCohorts(url: URL, ctx: HandlerCtx, op: MockOperator, res: ServerResponse): void {
  const visible = ctx.cohorts.filter(c => op.visible_cohort_ids.includes(c.cohort_id));
  const category = url.searchParams.get('category');
  const dataProviderDomain = url.searchParams.get('data_provider_domain');
  const q = url.searchParams.get('q')?.toLowerCase();

  let filtered = visible;
  if (category) filtered = filtered.filter(c => c.category === category);
  if (dataProviderDomain) filtered = filtered.filter(c => c.data_provider_domain === dataProviderDomain);
  if (q) {
    filtered = filtered.filter(
      c => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)
    );
  }

  const projected = filtered.map(c => projectCohortPricing(c, op));
  writeJson(res, 200, { cohorts: projected });
}

function handleGetCohort(cohortId: string, ctx: HandlerCtx, op: MockOperator, res: ServerResponse): void {
  const cohort = ctx.cohorts.find(c => c.cohort_id === cohortId);
  if (!cohort) {
    writeJson(res, 404, { code: 'cohort_not_found', message: `Cohort ${cohortId} not found.` });
    return;
  }
  if (!op.visible_cohort_ids.includes(cohortId)) {
    // Distinguish "not visible to you" from "doesn't exist" — both real upstreams
    // do this and it forces the adapter to handle 403 separately from 404.
    writeJson(res, 403, {
      code: 'cohort_not_visible',
      message: `Cohort ${cohortId} is not visible to operator ${op.operator_id}.`,
    });
    return;
  }
  writeJson(res, 200, projectCohortPricing(cohort, op));
}

function handleListDestinations(ctx: HandlerCtx, op: MockOperator, res: ServerResponse): void {
  const visible = ctx.destinations.filter(d => op.visible_destination_ids.includes(d.destination_id));
  writeJson(res, 200, { destinations: visible });
}

async function handleCreateActivation(
  req: IncomingMessage,
  ctx: HandlerCtx,
  op: MockOperator,
  res: ServerResponse
): Promise<void> {
  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    writeJson(res, 400, { code: 'invalid_json', message: 'Request body must be valid JSON.' });
    return;
  }
  if (!isObject(body)) {
    writeJson(res, 400, { code: 'invalid_request', message: 'Body must be an object.' });
    return;
  }
  const { cohort_id, destination_id, pricing_id, duration_days, client_request_id } = body as Record<
    string,
    unknown
  >;
  if (typeof cohort_id !== 'string' || typeof destination_id !== 'string' || typeof pricing_id !== 'string') {
    writeJson(res, 400, {
      code: 'invalid_request',
      message: 'cohort_id, destination_id, and pricing_id are required strings.',
    });
    return;
  }

  // Idempotency replay — same client_request_id under same operator returns the
  // existing activation. Different operators using the same client_request_id
  // are independent because the table is keyed on `<operator_id>::<key>`.
  if (typeof client_request_id === 'string' && client_request_id.length > 0) {
    const idemKey = `${op.operator_id}::${client_request_id}`;
    const existing = ctx.idempotency.get(idemKey);
    if (existing) {
      const activation = ctx.activations.get(existing);
      if (activation) {
        writeJson(res, 200, serializeActivation(activation));
        return;
      }
    }
  }

  const cohort = ctx.cohorts.find(c => c.cohort_id === cohort_id);
  if (!cohort || !op.visible_cohort_ids.includes(cohort_id)) {
    writeJson(res, cohort ? 403 : 404, {
      code: cohort ? 'cohort_not_visible' : 'cohort_not_found',
      message: `Cohort ${cohort_id} ${cohort ? 'not visible to operator' : 'not found'}.`,
    });
    return;
  }
  const destination = ctx.destinations.find(d => d.destination_id === destination_id);
  if (!destination || !op.visible_destination_ids.includes(destination_id)) {
    writeJson(res, destination ? 403 : 404, {
      code: destination ? 'destination_not_visible' : 'destination_not_found',
      message: `Destination ${destination_id} ${destination ? 'not visible' : 'not found'}.`,
    });
    return;
  }
  const pricingTiers = pricingForCohort(cohort, op);
  const tier = pricingTiers.find(t => t.pricing_id === pricing_id);
  if (!tier) {
    writeJson(res, 400, {
      code: 'invalid_pricing',
      message: `pricing_id ${pricing_id} is not a valid tier for this cohort under operator ${op.operator_id}.`,
    });
    return;
  }

  const activationId = `act_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (typeof duration_days === 'number' ? duration_days : 90) * 86400_000);

  // Agent destinations activate synchronously (the SA records and confirms);
  // DSP/CTV destinations are async — initial pending, transitions to active
  // when the storyboard's later poll fetches.
  const isAgentDest = destination.platform_type === 'agent';
  const activation: MockActivation = {
    activation_id: activationId,
    operator_id: op.operator_id,
    cohort_id,
    destination_id,
    pricing_id,
    status: isAgentDest ? 'active' : 'pending',
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    ...(isAgentDest
      ? {
          agent_activation_key: { agent_segment: cohort.data_provider_id },
          match_rate: destination.expected_match_rate ?? 0.9,
          member_count_matched: cohort.member_count,
        }
      : {}),
  };
  ctx.activations.set(activationId, activation);
  if (typeof client_request_id === 'string' && client_request_id.length > 0) {
    ctx.idempotency.set(`${op.operator_id}::${client_request_id}`, activationId);
  }

  writeJson(res, 201, serializeActivation(activation));
}

function handleGetActivation(activationId: string, ctx: HandlerCtx, op: MockOperator, res: ServerResponse): void {
  const activation = ctx.activations.get(activationId);
  if (!activation) {
    writeJson(res, 404, { code: 'activation_not_found', message: `Activation ${activationId} not found.` });
    return;
  }
  if (activation.operator_id !== op.operator_id) {
    // Cross-operator read attempt — surfaces as 403, not 404, so an attacker
    // can't probe activation ID space across tenants. Real platforms vary on
    // this (some return 404 to avoid existence oracles); 403 here is the
    // adopter-friendly choice for a fixture.
    writeJson(res, 403, {
      code: 'activation_not_visible',
      message: `Activation ${activationId} belongs to a different operator.`,
    });
    return;
  }
  // Auto-promote pending DSP activations to in_progress on first poll, then
  // active on second poll. Storyboard's polling loop walks this state machine.
  if (activation.status === 'pending') {
    activation.status = 'in_progress';
    activation.updated_at = new Date().toISOString();
  } else if (activation.status === 'in_progress') {
    const cohort = ctx.cohorts.find(c => c.cohort_id === activation.cohort_id);
    const destination = ctx.destinations.find(d => d.destination_id === activation.destination_id);
    activation.status = 'active';
    activation.match_rate = destination?.expected_match_rate ?? 0.75;
    activation.member_count_matched = Math.floor(
      (cohort?.member_count ?? 0) * (destination?.expected_match_rate ?? 0.75)
    );
    activation.platform_segment_id = `seg_${activation.activation_id.replace('act_', '')}`;
    activation.updated_at = new Date().toISOString();
  }
  writeJson(res, 200, serializeActivation(activation));
}

function projectCohortPricing(cohort: MockCohort, op: MockOperator): MockCohort {
  return {
    ...cohort,
    pricing: pricingForCohort(cohort, op),
  };
}

function pricingForCohort(cohort: MockCohort, op: MockOperator): MockPricingTier[] {
  const override = op.pricing_overrides[cohort.cohort_id];
  return override && override.length > 0 ? override : cohort.pricing;
}

function serializeActivation(a: MockActivation): Record<string, unknown> {
  // operator_id is internal book-keeping — not part of the public contract.
  const { operator_id, ...rest } = a;
  return rest;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
