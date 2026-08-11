import http from 'node:http';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { catalog, resolveModel, autoVisionEngine, assertSafeBaseURL } from './providers.js';
import { VisionCache, bodyHasImage, bridgeImages } from './vision.js';

const MAX_BODY_BYTES = Number(process.env.ZCODE_ROUTER_MAX_BODY_BYTES) || 64 * 1024 * 1024;

function keyMatches(presented, expected) {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authorized(req, config) {
  const header = req.headers.authorization || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : null;
  return keyMatches(presented, config.localKey);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function openaiError(res, status, message, code = null) {
  sendJson(res, status, { error: { message, type: 'invalid_request_error', code } });
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`request body exceeds ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function resolveVisionEngine(config) {
  const vb = config.visionBridge;
  if (!vb || vb.enabled === false) return null;
  if (vb.engine === 'local') {
    if (!vb.local?.baseURL || !vb.local?.model) return null;
    try {
      assertSafeBaseURL(vb.local.baseURL);
    } catch {
      return null;
    }
    return { baseURL: vb.local.baseURL.replace(/\/+$/, ''), key: null, model: vb.local.model, label: `local:${vb.local.model}` };
  }
  if (vb.engine && vb.engine !== 'auto') {
    const route = resolveModel(config, vb.engine);
    if (!route) return null;
    return { baseURL: route.baseURL, key: route.key, model: route.modelId, label: vb.engine };
  }
  return autoVisionEngine(config);
}

export function createRouter({ config, log = () => {}, fetchImpl = fetch }) {
  const visionCache = new VisionCache();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const route = url.pathname.replace(/^\/v1(?=\/)/, '');

      if (route === '/health' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, service: 'zcode-router' });
        return;
      }

      if (!authorized(req, config)) {
        openaiError(res, 401, 'Invalid or missing router key. Use the local key printed by `zcode-router start`.', 'invalid_api_key');
        return;
      }

      if (route === '/models' && req.method === 'GET') {
        sendJson(res, 200, {
          object: 'list',
          data: catalog(config).map((m) => ({
            id: m.id,
            object: 'model',
            created: 0,
            owned_by: m.provider,
          })),
        });
        return;
      }

      if (route === '/chat/completions' && req.method === 'POST') {
        await handleChat(req, res);
        return;
      }

      openaiError(res, 404, `Unknown route: ${req.method} ${url.pathname}`, 'not_found');
    } catch (err) {
      log(`request error: ${err.message}`);
      if (!res.headersSent) openaiError(res, 500, `Router error: ${err.message}`, 'internal_error');
      else res.end();
    }
  });

  // LLM streams run for minutes; Node's default request timeout would kill them.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  async function handleChat(req, res) {
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      openaiError(res, 400, 'Request body is not valid JSON', 'invalid_json');
      return;
    }

    const route = resolveModel(config, body.model || '');
    if (!route) {
      const known = catalog(config).map((m) => m.id);
      openaiError(
        res,
        404,
        `Unknown or unavailable model "${body.model}". Available: ${known.join(', ') || '(none — enable a provider first)'}`,
        'model_not_found'
      );
      return;
    }

    if (!route.meta.vision && bodyHasImage(body)) {
      const engine = resolveVisionEngine(config);
      if (engine) {
        await bridgeImages(body, engine, visionCache, { fetchImpl, log });
      }
    }

    const upstreamBody = { ...body, model: route.modelId };
    let upstream;
    try {
      upstream = await fetchImpl(`${route.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: body.stream ? 'text/event-stream' : 'application/json',
          ...(route.key ? { authorization: `Bearer ${route.key}` } : {}),
        },
        body: JSON.stringify(upstreamBody),
      });
    } catch (err) {
      openaiError(res, 502, `Upstream ${route.provider.id} unreachable: ${err.message}`, 'upstream_unreachable');
      return;
    }

    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json',
      'cache-control': 'no-cache',
    });
    if (!upstream.body) {
      res.end();
      return;
    }
    Readable.fromWeb(upstream.body).pipe(res);
    log(`${body.stream ? 'stream' : 'once'} ${body.model} -> ${route.provider.id}/${route.modelId} [${upstream.status}]`);
  }

  return server;
}

export function startServer({ config, log = console.error }) {
  return new Promise((resolve, reject) => {
    const server = createRouter({ config, log });
    server.on('error', reject);
    server.listen(config.port, '127.0.0.1', () => resolve(server));
  });
}
