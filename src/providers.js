// Built-in provider registry. Subscription providers (flat-rate plans) are the
// point of this project; plain pay-per-use APIs work too. `vision: false` is
// the conservative default — a model wrongly flagged vision-capable breaks
// turns when the upstream rejects image parts, a model wrongly flagged
// text-only just goes through the vision bridge.
//
// Catalog ids are `provider/id`. When upstream wants a different model string
// (ClinePass `cline-pass/…`, Command Code `google/gemini-…`), set `upstream`.

const m = (id, extra = {}) => ({ id, vision: false, protocol: 'openai', ...extra });

export const GROUP_ORDER = ['subscription', 'api', 'catalog'];

export const REGISTRY = {
  'opencode-go': {
    label: 'opencode Go (subscription)',
    group: 'subscription',
    baseURL: 'https://opencode.ai/zen/go/v1',
    keyEnv: ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY'],
    models: [
      m('deepseek-v4-flash'),
      m('deepseek-v4-pro'),
      m('glm-5.2'),
      m('glm-5.1'),
      m('kimi-k3', { vision: true }),
      m('kimi-k2.7-code'),
      m('kimi-k2.6'),
      m('mimo-v2.5'),
      m('mimo-v2.5-pro'),
      m('hy3'),
      m('grok-4.5', { vision: true }),
      m('minimax-m3', { vision: true, protocol: 'messages' }),
      m('minimax-m2.7', { protocol: 'messages' }),
      m('minimax-m2.5', { protocol: 'messages' }),
      m('qwen3.8-max', { vision: true, protocol: 'messages' }),
      m('qwen3.7-max', { vision: true, protocol: 'messages' }),
      m('qwen3.7-plus', { protocol: 'messages' }),
      m('qwen3.6-plus', { protocol: 'messages' }),
    ],
  },
  'opencode-zen': {
    label: 'opencode Zen (pay-per-use catalog)',
    group: 'catalog',
    baseURL: 'https://opencode.ai/zen/v1',
    keyEnv: ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY'],
    shareKeyWith: 'opencode-go',
    note: 'Same key as opencode Go. No preset models — type opencode-zen/<id> or run models add.',
    models: [],
  },
  clinepass: {
    label: 'ClinePass (subscription)',
    group: 'subscription',
    baseURL: 'https://api.cline.bot/api/v1',
    keyEnv: ['CLINEPASS_API_KEY', 'CLINE_API_KEY'],
    upstreamPrefix: 'cline-pass/',
    note: 'Requires an active ClinePass subscription.',
    models: [
      m('deepseek-v4-flash'),
      m('deepseek-v4-pro'),
      m('glm-5.2'),
      m('kimi-k3'),
      m('kimi-k2.7-code'),
      m('kimi-k2.6'),
      m('mimo-v2.5'),
      m('mimo-v2.5-pro'),
      m('minimax-m3'),
      m('qwen3.7-max'),
      m('qwen3.7-plus'),
      m('qwen3.8-max'),
    ],
  },
  'qwen-plan': {
    label: 'Qwen / Alibaba Model Studio plan (subscription)',
    group: 'subscription',
    baseURL: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    baseURLEnv: 'QWEN_PLAN_BASE_URL',
    keyEnv: ['QWEN_PLAN_API_KEY', 'DASHSCOPE_API_KEY'],
    note: 'Plan keys (sk-sp- prefix). Singapore token-plan URL by default; set QWEN_PLAN_BASE_URL for another region.',
    models: [
      m('qwen3.8-max', { vision: true }),
      m('qwen3.8-max-preview', { vision: true }),
      m('qwen3.7-max', { vision: true }),
      m('qwen3.7-plus'),
      m('qwen3.6-flash', { vision: true }),
      m('deepseek-v4-pro'),
      m('deepseek-v4-flash-0731'),
      m('glm-5.2'),
    ],
  },
  commandcode: {
    label: 'Command Code Provider API (subscription)',
    group: 'subscription',
    baseURL: 'https://api.commandcode.ai/provider/v1',
    keyEnv: ['COMMAND_CODE_API_KEY', 'COMMANDCODE_API_KEY'],
    note: 'Needs the Command Code Provider plan — Go plan CLI access is not enough.',
    models: [
      m('deepseek-v4-flash', { upstream: 'deepseek/deepseek-v4-flash' }),
      m('deepseek-v4-pro', { upstream: 'deepseek/deepseek-v4-pro' }),
      m('glm-5.2', { upstream: 'zai-org/GLM-5.2' }),
      m('kimi-k3', { vision: true, upstream: 'moonshotai/Kimi-K3' }),
      m('kimi-k2.7-code', { upstream: 'moonshotai/Kimi-K2.7-Code' }),
      m('mimo-v2.5-pro', { upstream: 'xiaomi/mimo-v2.5-pro' }),
      m('minimax-m3', { vision: true, upstream: 'MiniMaxAI/MiniMax-M3' }),
      m('minimax-m2.7', { upstream: 'MiniMaxAI/MiniMax-M2.7' }),
      m('qwen3.8-max', { vision: true, upstream: 'Qwen/Qwen3.8-Max' }),
      m('qwen3.7-max', { vision: true, upstream: 'Qwen/Qwen3.7-Max' }),
      m('qwen3.7-plus', { upstream: 'Qwen/Qwen3.7-Plus' }),
      m('grok-4.5', { vision: true, upstream: 'xai/grok-4.5' }),
      m('gemini-3.5-flash', { upstream: 'google/gemini-3.5-flash' }),
      m('gpt-5.5', { upstream: 'gpt-5.5' }),
      m('gpt-5.6-luna', { upstream: 'gpt-5.6-luna' }),
      m('hy3-paid', { upstream: 'tencent/hy3-paid' }),
      m('step-3.7-flash', { upstream: 'stepfun/Step-3.7-Flash' }),
      m('claude-opus-4.8', { vision: true, protocol: 'messages', upstream: 'claude-opus-4-8' }),
      m('claude-sonnet-5', { protocol: 'messages', upstream: 'claude-sonnet-5' }),
      m('claude-fable-5', { protocol: 'messages', upstream: 'claude-fable-5' }),
      m('claude-haiku-4.5', { protocol: 'messages', upstream: 'claude-haiku-4-5' }),
    ],
  },
  'minimax-token-plan': {
    label: 'MiniMax Token Plan (subscription)',
    group: 'subscription',
    baseURL: 'https://api.minimax.io/v1',
    keyEnv: ['MINIMAX_API_KEY', 'MINIMAX_TOKEN_PLAN_API_KEY'],
    models: [m('minimax-m3', { vision: true, upstream: 'MiniMax-M3' })],
  },
  'ollama-cloud': {
    label: 'Ollama Cloud (subscription)',
    group: 'subscription',
    baseURL: 'https://ollama.com/v1',
    keyEnv: ['OLLAMA_API_KEY', 'OLLAMA_CLOUD_API_KEY'],
    models: [
      m('glm-5.2'),
      m('kimi-k2.7-code'),
      m('minimax-m3', { vision: true }),
      m('deepseek-v4-pro'),
      m('deepseek-v4-flash', { upstream: 'deepseek-v4-flash:cloud' }),
    ],
  },
  deepseek: {
    label: 'DeepSeek (API)',
    group: 'api',
    baseURL: 'https://api.deepseek.com/v1',
    keyEnv: ['DEEPSEEK_API_KEY'],
    models: [m('deepseek-v4-flash'), m('deepseek-v4-pro')],
  },
  'kimi-api': {
    label: 'Kimi Platform API (global)',
    group: 'api',
    baseURL: 'https://api.moonshot.ai/v1',
    keyEnv: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
    models: [m('kimi-k3', { vision: true })],
  },
  'kimi-api-cn': {
    label: 'Kimi Platform API (China)',
    group: 'api',
    baseURL: 'https://api.moonshot.cn/v1',
    keyEnv: ['KIMI_API_CN_KEY', 'MOONSHOT_CN_API_KEY'],
    note: 'Keys are not interchangeable with the global platform.',
    models: [m('kimi-k3', { vision: true })],
  },
  'grok-api': {
    label: 'xAI Grok API',
    group: 'api',
    baseURL: 'https://api.x.ai/v1',
    keyEnv: ['XAI_API_KEY', 'GROK_API_KEY'],
    models: [m('grok-4.5', { vision: true })],
  },
  'anthropic-api': {
    label: 'Anthropic API',
    group: 'api',
    baseURL: 'https://api.anthropic.com/v1',
    keyEnv: ['ANTHROPIC_API_KEY'],
    protocol: 'messages',
    models: [m('claude-opus-4.8', { vision: true, protocol: 'messages', upstream: 'claude-opus-4-8' })],
  },
  'gemini-api': {
    label: 'Google Gemini API',
    group: 'api',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    note: 'No preset models — type gemini-api/<id> (e.g. gemini-2.5-flash) or run models add.',
    models: [],
  },
  groq: {
    label: 'Groq',
    group: 'catalog',
    baseURL: 'https://api.groq.com/openai/v1',
    keyEnv: ['GROQ_API_KEY'],
    models: [],
  },
  openrouter: {
    label: 'OpenRouter',
    group: 'catalog',
    baseURL: 'https://openrouter.ai/api/v1',
    keyEnv: ['OPENROUTER_API_KEY'],
    models: [],
  },
  together: {
    label: 'Together AI',
    group: 'catalog',
    baseURL: 'https://api.together.xyz/v1',
    keyEnv: ['TOGETHER_API_KEY'],
    models: [],
  },
  fireworks: {
    label: 'Fireworks AI',
    group: 'catalog',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    keyEnv: ['FIREWORKS_API_KEY'],
    models: [],
  },
  cerebras: {
    label: 'Cerebras',
    group: 'catalog',
    baseURL: 'https://api.cerebras.ai/v1',
    keyEnv: ['CEREBRAS_API_KEY'],
    models: [],
  },
  mistral: {
    label: 'Mistral AI',
    group: 'catalog',
    baseURL: 'https://api.mistral.ai/v1',
    keyEnv: ['MISTRAL_API_KEY'],
    models: [],
  },
  'nvidia-nim': {
    label: 'NVIDIA NIM',
    group: 'catalog',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    keyEnv: ['NVIDIA_API_KEY', 'NVIDIA_NIM_API_KEY'],
    models: [],
  },
  siliconflow: {
    label: 'SiliconFlow',
    group: 'catalog',
    baseURL: 'https://api.siliconflow.cn/v1',
    keyEnv: ['SILICONFLOW_API_KEY'],
    models: [],
  },
  huggingface: {
    label: 'Hugging Face Router',
    group: 'catalog',
    baseURL: 'https://router.huggingface.co/v1',
    keyEnv: ['HF_TOKEN', 'HUGGINGFACE_API_KEY'],
    models: [],
  },
  chutes: {
    label: 'Chutes',
    group: 'catalog',
    baseURL: 'https://llm.chutes.ai/v1',
    keyEnv: ['CHUTES_API_KEY'],
    models: [],
  },
};

function hydrateModel(base, user, model) {
  const e = typeof model === 'string' ? { id: model } : model;
  const protocol = user?.overrides?.[e.id]?.protocol ?? e.protocol ?? base.protocol ?? 'openai';
  const vision = user?.overrides?.[e.id]?.vision ?? e.vision ?? false;
  const upstream = e.upstream || (base.upstreamPrefix ? `${base.upstreamPrefix}${e.id}` : undefined);
  return { id: e.id, vision, protocol, ...(upstream ? { upstream } : {}) };
}

export function providerEntry(config, id) {
  const base = REGISTRY[id];
  const user = config?.providers?.[id];
  if (!base && !user) return null;
  if (base) {
    const extra = (user?.extra || []).map((model) => hydrateModel(base, user, model));
    return {
      id,
      label: base.label,
      group: base.group || 'api',
      note: base.note || null,
      protocol: base.protocol || 'openai',
      baseURL: user?.baseURL || (base.baseURLEnv && process.env[base.baseURLEnv]) || base.baseURL,
      keyEnv: base.keyEnv,
      shareKeyWith: base.shareKeyWith || null,
      enabled: Boolean(user?.enabled),
      storedKey: user?.key || null,
      models: [...base.models.map((model) => hydrateModel(base, user, model)), ...extra],
      custom: false,
    };
  }
  return {
    id,
    label: user.label || id,
    group: 'catalog',
    note: null,
    protocol: 'openai',
    baseURL: user.baseURL,
    keyEnv: [],
    shareKeyWith: null,
    enabled: Boolean(user.enabled),
    storedKey: user.key || null,
    models: (user.models || []).map((model) => hydrateModel({ protocol: 'openai' }, user, model)),
    custom: true,
  };
}

export function listProviders(config) {
  const ids = new Set([...Object.keys(REGISTRY), ...Object.keys(config?.providers || {})]);
  const entries = [...ids].map((id) => providerEntry(config, id)).filter(Boolean);
  entries.sort((a, b) => {
    const ga = GROUP_ORDER.indexOf(a.group);
    const gb = GROUP_ORDER.indexOf(b.group);
    const gi = (ga === -1 ? 99 : ga) - (gb === -1 ? 99 : gb);
    if (gi !== 0) return gi;
    const ia = Object.keys(REGISTRY).indexOf(a.id);
    const ib = Object.keys(REGISTRY).indexOf(b.id);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.id.localeCompare(b.id);
  });
  return entries;
}

export function setupEntries(config) {
  return listProviders(config).map((p) => ({
    id: p.id,
    label: p.label,
    group: p.group,
    keyReady: Boolean(resolveKey(p, config).key) || isLoopback(p.baseURL),
    enabled: p.enabled,
    note: p.note,
  }));
}

export function applyProviderSelection(cfg, selectedIds) {
  const selected = new Set(selectedIds);
  const next = { ...cfg, providers: { ...(cfg.providers || {}) } };
  for (const p of listProviders(cfg)) {
    const prev = next.providers[p.id] || {};
    if (selected.has(p.id)) {
      next.providers[p.id] = { ...prev, enabled: true };
      continue;
    }
    if (prev.key || prev.extra || prev.overrides || prev.baseURL || prev.models) {
      next.providers[p.id] = { ...prev, enabled: false };
    } else {
      delete next.providers[p.id];
    }
  }
  return next;
}

export function resolveKey(entry, config) {
  for (const env of entry.keyEnv || []) {
    if (process.env[env]) return { key: process.env[env], source: `env:${env}` };
  }
  if (entry.storedKey) return { key: entry.storedKey, source: 'stored' };
  if (entry.shareKeyWith && config?.providers?.[entry.shareKeyWith]?.key) {
    return { key: config.providers[entry.shareKeyWith].key, source: `stored:${entry.shareKeyWith}` };
  }
  return { key: null, source: null };
}

export function catalog(config) {
  const out = [];
  for (const p of listProviders(config)) {
    if (!p.enabled) continue;
    if (!resolveKey(p, config).key && !isLoopback(p.baseURL)) continue;
    for (const model of p.models) {
      out.push({ id: `${p.id}/${model.id}`, provider: p.id, vision: model.vision });
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
  const { key } = resolveKey(entry, config);
  if (!key && !isLoopback(entry.baseURL)) return null;
  // Passthrough: models not in the curated list still route. The router is a
  // byte-level proxy, and upstreams ship new models before the registry does —
  // typing `provider/new-model` in zCode just works (vision: false is the
  // conservative default; pin it with `models add ... --vision` if needed).
  const meta = entry.models.find((model) => model.id === modelId)
    || hydrateModel(REGISTRY[providerId] || { protocol: 'openai' }, config?.providers?.[providerId], { id: modelId });
  return {
    provider: entry,
    modelId,
    upstreamModel: meta.upstream || modelId,
    meta,
    key,
    baseURL: entry.baseURL.replace(/\/+$/, ''),
  };
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
    ? {
        baseURL: first.baseURL,
        key: first.key,
        model: first.upstreamModel,
        protocol: first.meta.protocol,
        label: `${first.provider.id}/${first.modelId}`,
      }
    : null;
}

export function probeHeaders(entry, key) {
  if (entry?.protocol === 'messages') {
    return key ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : {};
  }
  return key ? { authorization: `Bearer ${key}` } : {};
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
