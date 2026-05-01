import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { DEFAULT_API_KEY, TEMPLATES, WORKSPACES, type MockTemplate, type MockWorkspace } from './seed-data';

export interface BootOptions {
  port: number;
  apiKey?: string;
  templates?: MockTemplate[];
  workspaces?: MockWorkspace[];
}

export interface BootResult {
  url: string;
  close: () => Promise<void>;
}

interface MockRender {
  render_id: string;
  workspace_id: string;
  status: 'queued' | 'running' | 'complete' | 'failed';
  template_id: string;
  mode: 'preview' | 'build';
  /** Body fingerprint used for idempotency body-equivalence checks. */
  body_fingerprint: string;
  output?: {
    tag_html?: string;
    tag_javascript?: string;
    vast_xml?: string;
    preview_url?: string;
    assets?: Array<Record<string, unknown>>;
  };
  error?: { code: string; message: string };
  created_at: string;
  updated_at: string;
}

export async function bootCreativeTemplate(options: BootOptions): Promise<BootResult> {
  const apiKey = options.apiKey ?? DEFAULT_API_KEY;
  const templates = options.templates ?? TEMPLATES;
  const workspaces = options.workspaces ?? WORKSPACES;

  const renders = new Map<string, MockRender>();
  // client_request_id idempotency table — keyed by `<workspace_id>::<key>`.
  const idempotency = new Map<string, string>();

  const server = createServer((req, res) => {
    handleRequest(req, res, { apiKey, templates, workspaces, renders, idempotency }).catch(err => {
      const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
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
  templates: MockTemplate[];
  workspaces: MockWorkspace[];
  renders: Map<string, MockRender>;
  idempotency: Map<string, string>;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx): Promise<void> {
  // Authentication first.
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== ctx.apiKey) {
    writeJson(res, 401, { code: 'unauthorized', message: 'Missing or invalid bearer credential.' });
    return;
  }

  const url = new URL(req.url ?? '/', `http://127.0.0.1`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // Path-based workspace scoping. Matches /v3/workspaces/{ws}/...
  const wsMatch = path.match(/^\/v3\/workspaces\/([^/]+)(\/.*)?$/);
  if (!wsMatch || !wsMatch[1]) {
    writeJson(res, 404, { code: 'not_found', message: `No route for ${method} ${path}` });
    return;
  }
  const workspaceId = decodeURIComponent(wsMatch[1]);
  const subPath = wsMatch[2] ?? '/';
  const workspace = ctx.workspaces.find(w => w.workspace_id === workspaceId);
  if (!workspace) {
    writeJson(res, 404, { code: 'workspace_not_found', message: `Workspace ${workspaceId} not found.` });
    return;
  }

  // GET /v3/workspaces/{ws}/templates
  if (method === 'GET' && subPath === '/templates') {
    return handleListTemplates(url, ctx, workspace, res);
  }
  // GET /v3/workspaces/{ws}/templates/{tpl_id}
  const tplMatch = subPath.match(/^\/templates\/([^/]+)$/);
  if (method === 'GET' && tplMatch && tplMatch[1]) {
    return handleGetTemplate(decodeURIComponent(tplMatch[1]), ctx, workspace, res);
  }
  // POST /v3/workspaces/{ws}/renders
  if (method === 'POST' && subPath === '/renders') {
    return handleCreateRender(req, ctx, workspace, res);
  }
  // GET /v3/workspaces/{ws}/renders/{render_id}
  const rMatch = subPath.match(/^\/renders\/([^/]+)$/);
  if (method === 'GET' && rMatch && rMatch[1]) {
    return handleGetRender(decodeURIComponent(rMatch[1]), ctx, workspace, res);
  }

  writeJson(res, 404, { code: 'not_found', message: `No route for ${method} ${path}` });
}

function handleListTemplates(url: URL, ctx: HandlerCtx, ws: MockWorkspace, res: ServerResponse): void {
  const visible = ctx.templates.filter(t => ws.visible_template_ids.includes(t.template_id));
  const channel = url.searchParams.get('channel');
  const filtered = channel ? visible.filter(t => t.channel === channel) : visible;
  writeJson(res, 200, { templates: filtered });
}

function handleGetTemplate(templateId: string, ctx: HandlerCtx, ws: MockWorkspace, res: ServerResponse): void {
  const template = ctx.templates.find(t => t.template_id === templateId);
  if (!template) {
    writeJson(res, 404, { code: 'template_not_found', message: `Template ${templateId} not found.` });
    return;
  }
  if (!ws.visible_template_ids.includes(templateId)) {
    writeJson(res, 404, {
      code: 'template_not_visible',
      message: `Template ${templateId} is not visible to workspace ${ws.workspace_id}.`,
    });
    return;
  }
  writeJson(res, 200, template);
}

async function handleCreateRender(
  req: IncomingMessage,
  ctx: HandlerCtx,
  ws: MockWorkspace,
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
  const { template_id, inputs, mode, client_request_id } = body as Record<string, unknown>;
  if (typeof template_id !== 'string' || !Array.isArray(inputs) || (mode !== 'preview' && mode !== 'build')) {
    writeJson(res, 400, {
      code: 'invalid_request',
      message: 'template_id (string), inputs (array), and mode ("preview" or "build") are required.',
    });
    return;
  }
  const template = ctx.templates.find(t => t.template_id === template_id);
  if (!template || !ws.visible_template_ids.includes(template_id)) {
    writeJson(res, 404, {
      code: template ? 'template_not_visible' : 'template_not_found',
      message: `Template ${template_id} ${template ? 'not visible' : 'not found'}.`,
    });
    return;
  }

  const fingerprint = fingerprintBody(template_id, inputs, mode);

  // Idempotency replay (same body) / conflict (mismatched body).
  if (typeof client_request_id === 'string' && client_request_id.length > 0) {
    const idemKey = `${ws.workspace_id}::${client_request_id}`;
    const existing = ctx.idempotency.get(idemKey);
    if (existing) {
      const render = ctx.renders.get(existing);
      if (render) {
        if (render.body_fingerprint !== fingerprint) {
          writeJson(res, 409, {
            code: 'idempotency_conflict',
            message: `client_request_id ${client_request_id} was previously used with a different body. Use a fresh idempotency key for distinct requests.`,
          });
          return;
        }
        writeJson(res, 200, serializeRender(render));
        return;
      }
    }
  }

  const renderId = `rnd_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date();
  const render: MockRender = {
    render_id: renderId,
    workspace_id: ws.workspace_id,
    status: 'queued',
    template_id,
    mode,
    body_fingerprint: fingerprint,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  ctx.renders.set(renderId, render);
  if (typeof client_request_id === 'string' && client_request_id.length > 0) {
    ctx.idempotency.set(`${ws.workspace_id}::${client_request_id}`, renderId);
  }

  writeJson(res, 202, serializeRender(render));
}

function handleGetRender(renderId: string, ctx: HandlerCtx, ws: MockWorkspace, res: ServerResponse): void {
  const render = ctx.renders.get(renderId);
  if (!render) {
    writeJson(res, 404, { code: 'render_not_found', message: `Render ${renderId} not found.` });
    return;
  }
  if (render.workspace_id !== ws.workspace_id) {
    writeJson(res, 404, {
      code: 'render_not_in_workspace',
      message: `Render ${renderId} not found in workspace ${ws.workspace_id}.`,
    });
    return;
  }

  // Auto-promote queued → running on first poll, running → complete on second.
  // Real platforms render in seconds-to-minutes; the mock simulates a fast
  // async with two state transitions to exercise polling without making the
  // matrix run drag.
  const template = ctx.templates.find(t => t.template_id === render.template_id);
  if (render.status === 'queued') {
    render.status = 'running';
    render.updated_at = new Date().toISOString();
  } else if (render.status === 'running') {
    render.status = 'complete';
    render.updated_at = new Date().toISOString();
    render.output = synthesizeOutput(render, template);
  }

  writeJson(res, 200, serializeRender(render));
}

function synthesizeOutput(render: MockRender, template: MockTemplate | undefined): MockRender['output'] {
  // Fixture output. Real platforms return real ad tags / VAST XML / etc; the
  // mock returns plausible-looking synthetic output so adapters can pattern-
  // match without rendering anything real. The kind is driven by the
  // template's output_kind so the adapter has to read it and project to AdCP
  // creative_manifest correctly.
  const previewBase = `https://mock-creative-template.example/preview/${render.render_id}`;
  if (!template) {
    return { preview_url: previewBase };
  }
  if (template.output_kind === 'vast_xml') {
    return {
      vast_xml: `<?xml version="1.0"?><VAST version="4.2"><Ad id="${render.render_id}"><InLine><AdSystem>MockCreativeTemplate</AdSystem><AdTitle>${template.name}</AdTitle></InLine></Ad></VAST>`,
      preview_url: previewBase,
      assets: [{ kind: 'video_tag', mime_type: 'application/xml+vast' }],
    };
  }
  if (template.output_kind === 'javascript_tag') {
    return {
      tag_javascript: `(function(){var d=document;var img=d.createElement('img');img.src='${previewBase}.png';d.write(img.outerHTML);})();`,
      preview_url: previewBase,
      assets: [{ kind: 'js_tag', mime_type: 'application/javascript' }],
    };
  }
  // default html_tag
  return {
    tag_html: `<a href="https://example.com/click"><img src="${previewBase}.png" width="${template.dimensions?.width ?? 300}" height="${template.dimensions?.height ?? 250}" alt="${template.name}" /></a>`,
    preview_url: previewBase,
    assets: [{ kind: 'html_tag', mime_type: 'text/html' }],
  };
}

function serializeRender(r: MockRender): Record<string, unknown> {
  // workspace_id / body_fingerprint are internal book-keeping — strip from public payload.
  const { workspace_id, body_fingerprint, ...rest } = r;
  return rest;
}

function fingerprintBody(templateId: string, inputs: unknown[], mode: string): string {
  // Stable JSON canonicalization for body equivalence. Serializing a sorted-
  // key copy gives whitespace/order independence without pulling in a
  // dependency. Inputs are array-position-significant (slot order matters
  // for some upstream renders), so we don't sort the array itself.
  return JSON.stringify({ template_id: templateId, inputs, mode });
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
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
