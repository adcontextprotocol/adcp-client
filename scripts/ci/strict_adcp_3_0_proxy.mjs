#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';

const listenPort = Number.parseInt(process.env.ADCP_STRICT_PROXY_PORT ?? process.env.ADCP_PORT ?? '3003', 10);
const targetPort = Number.parseInt(process.env.ADCP_STRICT_PROXY_TARGET_PORT ?? '3001', 10);

if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
  throw new Error(`Invalid ADCP_STRICT_PROXY_PORT/ADCP_PORT: ${process.env.ADCP_STRICT_PROXY_PORT ?? process.env.ADCP_PORT}`);
}
if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
  throw new Error(`Invalid ADCP_STRICT_PROXY_TARGET_PORT: ${process.env.ADCP_STRICT_PROXY_TARGET_PORT}`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeJsonBody(buffer) {
  if (buffer.length === 0) return undefined;
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return undefined;
  }
}

function iterJsonRpcMessages(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') return [body];
  return [];
}

const STRICT_ARGUMENT_KEYS_BY_TOOL = new Map([
  ['get_adcp_capabilities', new Set(['adcp_major_version', 'context', 'ext', 'protocols'])],
  [
    'get_products',
    new Set(['account', 'adcp_major_version', 'brand', 'brief', 'buying_mode', 'context', 'ext', 'pagination']),
  ],
]);

const auditPath = process.env.ADCP_STRICT_PROXY_AUDIT_PATH;
const audit = {
  forwardedToolCallCount: 0,
  rejectedToolCallCount: 0,
  forwardedTools: {},
  rejectedTools: {},
};

function writeAudit() {
  if (!auditPath) return;
  fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2));
}

function recordToolCalls(body, bucketName) {
  for (const message of iterJsonRpcMessages(body)) {
    if (!message || typeof message !== 'object') continue;
    if (message.method !== 'tools/call') continue;
    const toolName = typeof message.params?.name === 'string' ? message.params.name : '<unknown>';
    if (bucketName === 'forwarded') {
      audit.forwardedToolCallCount += 1;
      audit.forwardedTools[toolName] = (audit.forwardedTools[toolName] ?? 0) + 1;
    } else {
      audit.rejectedToolCallCount += 1;
      audit.rejectedTools[toolName] = (audit.rejectedTools[toolName] ?? 0) + 1;
    }
  }
  writeAudit();
}

function findUnexpectedArgument(body) {
  for (const message of iterJsonRpcMessages(body)) {
    if (!message || typeof message !== 'object') continue;
    if (message.method !== 'tools/call') continue;
    const toolName = message.params?.name;
    const allowed = STRICT_ARGUMENT_KEYS_BY_TOOL.get(toolName);
    if (!allowed) continue;
    const args = message.params?.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args)) continue;
    for (const key of Object.keys(args)) {
      if (!allowed.has(key)) return key;
    }
  }
  return undefined;
}

function firstRpcId(body) {
  for (const message of iterJsonRpcMessages(body)) {
    if (message && typeof message === 'object' && Object.hasOwn(message, 'id')) {
      return message.id;
    }
  }
  return null;
}

function rejectUnexpectedArgument(res, body, field) {
  const response = {
    jsonrpc: '2.0',
    id: firstRpcId(body),
    error: {
      code: -32602,
      message: `Unexpected keyword argument '${field}'`,
    },
  };
  const payload = JSON.stringify(response);
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function forwardRequest(req, res, bodyBuffer) {
  const headers = { ...req.headers };
  headers.host = `127.0.0.1:${targetPort}`;
  headers['content-length'] = String(bodyBuffer.length);

  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: targetPort,
      method: req.method,
      path: req.url,
      headers,
    },
    proxyRes => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', err => {
    const payload = JSON.stringify({ error: `strict 3.0 proxy upstream error: ${err.message}` });
    res.writeHead(502, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
  });

  proxyReq.end(bodyBuffer);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url?.startsWith('/mcp')) {
    const bodyBuffer = await readBody(req);
    const body = decodeJsonBody(bodyBuffer);
    const unexpectedArgument = findUnexpectedArgument(body);
    if (unexpectedArgument) {
      recordToolCalls(body, 'rejected');
      rejectUnexpectedArgument(res, body, unexpectedArgument);
      return;
    }
    recordToolCalls(body, 'forwarded');
    forwardRequest(req, res, bodyBuffer);
    return;
  }

  forwardRequest(req, res, Buffer.alloc(0));
});

server.listen(listenPort, '127.0.0.1', () => {
  process.stderr.write(
    `[strict-adcp-3-0-proxy] listening on http://127.0.0.1:${listenPort}, forwarding to ${targetPort}\n`
  );
});
