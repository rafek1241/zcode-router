// Verbose request dumps for `zcode-router start --verbose`. Secrets and image
// bytes are stripped so the log is safe to paste into an issue.

export function redactSecrets(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi, (m) => `[data-url ${m.length} chars]`)
    .replace(/(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._\-]+)/g, '<redacted-key>');
}

export function headerSummary(req) {
  return {
    authorization: req.headers.authorization ? (String(req.headers.authorization).startsWith('Bearer ') ? 'Bearer <redacted>' : '<set>') : undefined,
    'x-api-key': req.headers['x-api-key'] ? '<redacted>' : undefined,
    'content-type': req.headers['content-type'],
    'anthropic-version': req.headers['anthropic-version'],
    'user-agent': req.headers['user-agent'],
    accept: req.headers.accept,
  };
}

function clip(s, n = 800) {
  const t = redactSecrets(s);
  return t.length > n ? `${t.slice(0, n)}…<${t.length - n} more chars>` : t;
}

export function summarizeBody(body, limit = 800) {
  const messages = (body?.messages || []).map((m, i) => {
    const entry = { i, role: m.role };
    if (typeof m.content === 'string') {
      entry.content = clip(m.content, limit);
      return entry;
    }
    if (!Array.isArray(m.content)) {
      entry.contentType = typeof m.content;
      return entry;
    }
    entry.parts = m.content.map((p) => {
      if (!p || typeof p !== 'object') return { type: typeof p };
      const part = { type: p.type };
      if (typeof p.text === 'string') part.text = clip(p.text, limit);
      const url = p.image_url?.url || p.image_url || p.url || p.file_url?.url;
      if (typeof url === 'string') part.url = clip(url, 120);
      if (p.source?.type) part.source = p.source.type;
      if (p.tool_call_id) part.tool_call_id = p.tool_call_id;
      return part;
    });
    return entry;
  });
  return {
    model: body?.model,
    stream: Boolean(body?.stream),
    max_tokens: body?.max_tokens ?? body?.max_completion_tokens,
    tools: Array.isArray(body?.tools) ? body.tools.length : 0,
    files: Array.isArray(body?.files) ? body.files.length : 0,
    keys: Object.keys(body || {}),
    messages,
  };
}

export function looksLikeOmittedImage(body) {
  const blob = JSON.stringify(body?.messages || []);
  return /does not support image input|image-cache|omitted from the provider request/i.test(blob);
}
