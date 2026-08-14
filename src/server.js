import http from 'node:http';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { catalog, resolveModel, autoVisionEngine, assertSafeBaseURL } from './providers.js';
import { bindHost } from './config.js';
import { VisionCache, bodyHasImage, bridgeImages, bridgeFiles, contentShape } from './vision.js';
import { headerSummary, summarizeBody, looksLikeOmittedImage } from './debug.js';
import { recordLastError } from './last-error.js';
import {
  anthropicToOpenai,
  openaiToAnthropic,
  AnthropicStreamTranslator,
  OpenAIStreamTranslator,
  openaiToAnthropicRequest,
  anthropicToOpenaiResponse,
  estimateTokens,
} from './anthropic.js';

const MAX_BODY_BYTES = Number(process.env.ZCODE_ROUTER_MAX_BODY_BYTES) || 64 * 1024 * 1024;

function keyMatches(presented, expected) {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authorized(req, config) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  // Anthropic-protocol clients (ZCode's default) authenticate with x-api-key.
  const xkey = req.headers['x-api-key'];
  return keyMatches(bearer, config.localKey) || keyMatches(typeof xkey === 'string' ? xkey : null, config.localKey);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function openaiError(res, status, message, code = null) {
  sendJson(res, status, { error: { message, type: 'invalid_request_error', code } });
}

const ANTHROPIC_ERROR_TYPE = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  429: 'rate_limit_error',
};

function anthropicError(res, status, message) {
  sendJson(res, status, { type: 'error', error: { type: ANTHROPIC_ERROR_TYPE[status] || 'api_error', message } });
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
    return { baseURL: vb.local.baseURL.replace(/\/+$/, ''), key: null, model: vb.local.model, protocol: 'openai', label: `local:${vb.local.model}` };
  }
  if (vb.engine && vb.engine !== 'auto') {
    const route = resolveModel(config, vb.engine);
    if (!route) return null;
    return { baseURL: route.baseURL, key: route.key, model: route.upstreamModel, protocol: route.meta.protocol, label: vb.engine };
  }
  return autoVisionEngine(config);
}

export function createRouter({ config, log = () => {}, fetchImpl = fetch, verbose = false }) {
  const visionCache = new VisionCache();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const route = url.pathname.replace(/^\/v1(?=\/)/, '');
      const anthropic = route === '/messages' || route === '/messages/count_tokens';
      const fail = anthropic ? anthropicError : openaiError;
      if (verbose) log(`http ${req.method} ${url.pathname} ${JSON.stringify(headerSummary(req))}`);

      if (route === '/health' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, service: 'zcode-router' });
        return;
      }

      if (!authorized(req, config)) {
        fail(res, 401, 'Invalid or missing router key. Use the local key printed by `zcode-router start`.');
        return;
      }

      if (route === '/models' && req.method === 'GET') {
        // Union shape: OpenAI + Anthropic fields. ZCode gates screenshot
        // attachments on modalities.input / supportsImages — without those it
        // treats the model as text-only, drops the image from the API request,
        // and the agent tries local OCR instead of the vision bridge.
        const engine = resolveVisionEngine(config);
        const data = catalog(config).map((m) => {
          const images = m.vision || Boolean(engine);
          return {
            id: m.id,
            object: 'model',
            created: 0,
            owned_by: m.provider,
            type: 'model',
            display_name: m.id,
            created_at: '2026-01-01T00:00:00Z',
            supportsImages: images,
            supports_image_input: images,
            modalities: { input: images ? ['text', 'image'] : ['text'], output: ['text'] },
            architecture: {
              modality: images ? 'text+image->text' : 'text->text',
              input_modalities: images ? ['text', 'image'] : ['text'],
              output_modalities: ['text'],
            },
          };
        });
        sendJson(res, 200, { object: 'list', data, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null, has_more: false });
        if (verbose) log(`models: ${data.length} entries, image advertised on ${data.filter((m) => m.supportsImages).length}, engine=${engine?.label || 'none'}`);
        return;
      }

      if (route === '/messages/count_tokens' && req.method === 'POST') {
        const raw = await readBody(req);
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          anthropicError(res, 400, 'Request body is not valid JSON');
          return;
        }
        sendJson(res, 200, { input_tokens: estimateTokens(body) });
        return;
      }

      if ((route === '/chat/completions' || route === '/messages') && req.method === 'POST') {
        await handleChat(req, res, anthropic);
        return;
      }

      fail(res, 404, `Unknown route: ${req.method} ${url.pathname}`);
    } catch (err) {
      log(`request error: ${err.message}`);
      if (!res.headersSent) openaiError(res, 500, `Router error: ${err.message}`, 'internal_error');
      else res.end();
    }
  });

  // LLM streams run for minutes; Node's default request timeout would kill them.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  async function handleChat(req, res, anthropic) {
    const raw = await readBody(req);
    let clientBody;
    try {
      clientBody = JSON.parse(raw);
    } catch {
      (anthropic ? anthropicError : openaiError)(res, 400, 'Request body is not valid JSON');
      return;
    }

    const requestedModel = clientBody.model || '';
    const route = resolveModel(config, requestedModel);
    if (!route) {
      const known = catalog(config).map((m) => m.id);
      (anthropic ? anthropicError : openaiError)(
        res,
        404,
        `Unknown or unavailable model "${requestedModel}". Available: ${known.join(', ') || '(none — enable a provider first)'}`
      );
      return;
    }

    // Canonical shape is OpenAI chat completions: translate Anthropic requests
    // first so the vision bridge works identically for both protocols.
    const body = anthropic ? anthropicToOpenai(clientBody) : clientBody;
    const shape = contentShape(body);
    const hasImage = bodyHasImage(body);
    const omitted = looksLikeOmittedImage(body);
    if (verbose) {
      log(`chat in protocol=${anthropic ? 'messages' : 'openai'} bytes=${raw.length} hasImage=${hasImage} omittedHint=${omitted} shape=${shape}`);
      log(`chat body ${JSON.stringify(summarizeBody(clientBody))}`);
    } else if (omitted && !hasImage) {
      log(`vision-bridge: zCode omitted-image reminder in request but no image part detected (shape ${shape}) — will try cache-path extraction`);
    }

    if (!route.meta.vision && (hasImage || omitted)) {
      const engine = resolveVisionEngine(config);
      if (engine) {
        if (verbose) log(`vision-bridge: running engine=${engine.label} protocol=${engine.protocol} nativeVision=${route.meta.vision}`);
        await bridgeImages(body, engine, visionCache, { fetchImpl, log, verbose });
      } else {
        log(`vision-bridge: images/omitted-hint present but no engine (shape ${shape})`);
      }
    } else if (verbose) {
      log(`vision-bridge: skipped nativeVision=${route.meta.vision} hasImage=${hasImage} omittedHint=${omitted}`);
    }
    await bridgeFiles(body, { log, cache: visionCache });

    const upstreamBody = { ...body, model: route.upstreamModel };
    const messagesUpstream = route.meta.protocol === 'messages';
    const timeoutMs = Number(process.env.ZCODE_ROUTER_UPSTREAM_TIMEOUT_MS);
    const ms = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 120_000;
    let upstream;
    try {
      upstream = await fetchImpl(`${route.baseURL}/${messagesUpstream ? 'messages' : 'chat/completions'}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: body.stream ? 'text/event-stream' : 'application/json',
          ...(messagesUpstream
            ? { 'x-api-key': route.key || '', 'anthropic-version': '2023-06-01' }
            : route.key
              ? { authorization: `Bearer ${route.key}` }
              : {}),
        },
        body: JSON.stringify(messagesUpstream ? openaiToAnthropicRequest(upstreamBody) : upstreamBody),
        signal: !body.stream && ms > 0 ? AbortSignal.timeout(ms) : undefined,
      });
    } catch (err) {
      recordLastError({
        providerId: route.provider.id,
        routedId: requestedModel,
        upstreamModel: route.upstreamModel,
        status: 502,
        detail: err.message,
      });
      (anthropic ? anthropicError : openaiError)(res, 502, `Upstream ${route.provider.id} unreachable: ${err.message}`);
      return;
    }

    log(`${body.stream ? 'stream' : 'once'} ${anthropic ? 'messages' : 'chat'} ${requestedModel} -> ${route.provider.id}/${route.modelId} [${upstream.status}] ${shape}${omitted ? ' omitted-hint' : ''}${hasImage ? ' has-image' : ''}`);

    const rememberFail = (detail) => {
      recordLastError({
        providerId: route.provider.id,
        routedId: requestedModel,
        upstreamModel: route.upstreamModel,
        status: upstream.status,
        detail,
      });
    };

    if (!anthropic && !messagesUpstream) {
      // OpenAI-protocol client, OpenAI-protocol upstream: faithful byte pass-through.
      if (!upstream.ok) {
        const raw = await upstream.text().catch(() => '');
        rememberFail(raw);
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') || 'application/json',
          'cache-control': 'no-cache',
        });
        res.end(raw);
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
      return;
    }

    if (!upstream.ok) {
      const detail = (await upstream.text().catch(() => '')).slice(0, 300);
      rememberFail(detail);
      (anthropic ? anthropicError : openaiError)(res, upstream.status, `Upstream ${route.provider.id} answered HTTP ${upstream.status}: ${detail}`);
      return;
    }

    if (!body.stream) {
      const raw = await upstream.json();
      const openaiShape = messagesUpstream ? anthropicToOpenaiResponse(raw, requestedModel) : raw;
      if (anthropic) sendJson(res, 200, openaiToAnthropic(openaiShape, requestedModel));
      else sendJson(res, 200, openaiShape);
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    // For messages-protocol upstreams, normalize the SSE stream to OpenAI
    // chunks first; an Anthropic client then gets them re-translated.
    const upstreamTranslator = messagesUpstream ? new OpenAIStreamTranslator(requestedModel) : null;
    const clientTranslator = anthropic ? new AnthropicStreamTranslator(requestedModel, `msg_${crypto.randomBytes(12).toString('hex')}`) : null;
    const reader = Readable.fromWeb(upstream.body);
    let buffer = '';
    const handleLine = (line) => {
      if (!line) return;
      const lines = upstreamTranslator ? upstreamTranslator.push(line) : [line];
      for (const l of lines) {
        if (clientTranslator) {
          for (const l2 of l.split('\n')) {
            for (const out of clientTranslator.push(l2)) res.write(out);
          }
        } else {
          res.write(l.endsWith('\n') ? l : `${l}\n`);
        }
      }
    };
    reader.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        handleLine(line);
      }
    });
    reader.on('end', () => {
      if (buffer.trim()) handleLine(buffer.replace(/\r$/, ''));
      if (upstreamTranslator) for (const l of upstreamTranslator.finalize()) handleLine(l);
      if (clientTranslator) {
        const tail = [];
        clientTranslator.finalize(tail, null);
        for (const out of tail) res.write(out);
      }
      res.end();
    });
    reader.on('error', (err) => {
      log(`stream error: ${err.message}`);
      res.end();
    });
  }

  return server;
}

export function startServer({ config, log = console.error, verbose = false }) {
  return new Promise((resolve, reject) => {
    const server = createRouter({ config, log, verbose });
    server.on('error', reject);
    server.listen(config.port, bindHost(), () => resolve(server));
  });
}
