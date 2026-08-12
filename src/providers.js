// Built-in provider registry. Subscription providers (flat-rate plans) are the
// point of this project; plain pay-per-use APIs work too. `vision: false` is
// the conservative default — a model wrongly flagged vision-capable breaks
// turns when the upstream rejects image parts, a model wrongly flagged
// text-only just goes through the vision bridge.

export const REGISTRY = {
  'opencode-go': {
    label: 'opencode Go (subscription)',
    baseURL: 'https://opencode.ai/zen/go/v1',
    keyEnv: ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY'],
    models: [
      { id: 'deepseek-v4-flash', vision: false },
      { id: 'deepseek-v4-pro', vision: false },
      { id: 'glm-5.2', vision: false },
      { id: 'glm-5.1', vision: false },
      { id: 'kimi-k3', vision: false },
      { id: 'kimi-k2.7-code', vision: false },
      { id: 'kimi-k2.6', vision: false },
      { id: 'mimo-v2.5', vision: false },
      { id: 'mimo-v2.5-pro', vision: false },
      { id: 'hy3', vision: false },
      { id: 'grok-4.5', vision: true },
      // opencode Go serves these only over the Anthropic Messages endpoint:
      { id: 'minimax-m3', vision: true, protocol: 'messages' },
      { id: 'minimax-m2.7', vision: false, protocol: 'messages' },
      { id: 'minimax-m2.5', vision: false, protocol: 'messages' },
      { id: 'qwen3.8-max', vision: false, protocol: 'messages' },
      { id: 'qwen3.7-max', vision: false, protocol: 'messages' },
      { id: 'qwen3.7-plus', vision: false, protocol: 'messages' },
      { id: 'qwen3.6-plus', vision: false, protocol: 'messages' },
      // gpt-5.6-luna is served only over the OpenAI Responses endpoint, which
      // this router does not implement.
    ],
  },
  clinepass: {
    label: 'ClinePass (subscription)',
    baseURL: 'https://api.cline.bot/api/v1',
    keyEnv: ['CLINEPASS_API_KEY', 'CLINE_API_KEY'],
    models: [
      { id: 'deepseek-v4-flash', vision: false },
      { id: 'deepseek-v4-pro', vision: false },
      { id: 'glm-5.2', vision: false },
      { id: 'kimi-k3', vision: false },
      { id: 'kimi-k2.7-code', vision: false },
      { id: 'kimi-k2.6', vision: false },
      { id: 'mimo-v2.5', vision: false },
      { id: 'mimo-v2.5-pro', vision: false },
      { id: 'minimax-m3', vision: false },
      { id: 'qwen3.7-max', vision: false },
      { id: 'qwen3.7-plus', vision: false },
      { id: 'qwen3.8-max', vision: false },
    ],
  },
  deepseek: {
    label: 'DeepSeek (API)',
    baseURL: 'https://api.deepseek.com/v1',
    keyEnv: ['DEEPSEEK_API_KEY'],
    models: [
      { id: 'deepseek-v4-flash', vision: false },
      { id: 'deepseek-v4-pro', vision: false },
    ],
  },
};

export function providerEntry(config, id) {
  const base = REGISTRY[id];
  const user = config?.providers?.[id];
  if (!base && !user) return null;
  if (base) {
    const extra = (user?.extra || []).map((m) => {
      const e = typeof m === 'string' ? { id: m } : m;
      return {
        id: e.id,
        vision: user?.overrides?.[e.id]?.vision ?? e.vision ?? false,
        protocol: e.protocol || 'openai',
      };
    });
    return {
      id,
      label: base.label,
      baseURL: user?.baseURL || base.baseURL,
      keyEnv: base.keyEnv,
      enabled: Boolean(user?.enabled),
      storedKey: user?.key || null,
      models: [
        ...base.models.map((m) => ({
          protocol: 'openai',
          ...m,
          vision: user?.overrides?.[m.id]?.vision ?? m.vision,
        })),
        ...extra,
      ],
      custom: false,
    };
  }
  // Custom provider: fully user-defined.
  return {
    id,
    label: user.label || id,
    baseURL: user.baseURL,
    keyEnv: [],
    enabled: Boolean(user.enabled),
    storedKey: user.key || null,
    models: (user.models || []).map((m) =>
      typeof m === 'string' ? { id: m, vision: false, protocol: 'openai' } : { vision: false, protocol: 'openai', ...m }
    ),
    custom: true,
  };
}

export function listProviders(config) {
  const ids = new Set([...Object.keys(REGISTRY), ...Object.keys(config?.providers || {})]);
  return [...ids].map((id) => providerEntry(config, id)).filter(Boolean);
}

export function resolveKey(entry) {
  for (const env of entry.keyEnv || []) {
    if (process.env[env]) return { key: process.env[env], source: `env:${env}` };
  }
  if (entry.storedKey) return { key: entry.storedKey, source: 'stored' };
  return { key: null, source: null };
}

export function catalog(config) {
  const out = [];
  for (const p of listProviders(config)) {
    if (!p.enabled) continue;
    if (!resolveKey(p).key && !isLoopback(p.baseURL)) continue;
    for (const m of p.models) {
      out.push({ id: `${p.id}/${m.id}`, provider: p.id, vision: m.vision });
    }
  }
  return out;
}

export function resolveModel(config, routedId) {
  const slash = routedId.indexOf('/');
  if (slash <= 0) return null;
  const providerId = routedId.slice(0, slash);
  const modelId = routedId.slice(slash + 1);
  const entry = providerEntry(config, providerId);
  if (!entry || !entry.enabled) return null;
  const { key } = resolveKey(entry);
  if (!key && !isLoopback(entry.baseURL)) return null;
  // Passthrough: models not in the curated list still route. The router is a
  // byte-level proxy, and upstreams ship new models before the registry does —
  // typing `provider/new-model` in zCode just works (vision: false is the
  // conservative default; pin it with `models add ... --vision` if needed).
  const meta = entry.models.find((m) => m.id === modelId) || { id: modelId, vision: false, protocol: 'openai' };
  return { provider: entry, modelId, meta, key, baseURL: entry.baseURL.replace(/\/+$/, '') };
}

// Vision models that are cheap enough to read screenshots all day.
const CHEAP_TIER = /flash|haiku|mini|turbo|small|lite/i;

export function autoVisionEngine(config) {
  const candidates = [];
  for (const item of catalog(config)) {
    if (!item.vision) continue;
    const route = resolveModel(config, item.id);
    if (route) candidates.push(route);
  }
  candidates.sort((a, b) => Number(!CHEAP_TIER.test(a.modelId)) - Number(!CHEAP_TIER.test(b.modelId)));
  const first = candidates[0];
  return first
    ? { baseURL: first.baseURL, key: first.key, model: first.modelId, protocol: first.meta.protocol, label: `${first.provider.id}/${first.modelId}` }
    : null;
}

export function isLoopback(url) {
  try {
    const h = new URL(url).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
}

// Upstream base URLs must be HTTPS — API keys ride in every request header.
// Loopback is exempt so local runtimes (Ollama, LM Studio) can be vision engines.
export function assertSafeBaseURL(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Invalid base URL: ${url}`);
  }
  if (u.protocol === 'https:') return;
  if (u.protocol === 'http:' && isLoopback(url)) return;
  throw new Error(`Refusing insecure base URL (https required, loopback excepted): ${url}`);
}
