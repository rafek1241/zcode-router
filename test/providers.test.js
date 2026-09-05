import test from 'node:test';
import assert from 'node:assert/strict';
import { REGISTRY, providerEntry, resolveModel, resolveKey, catalog, autoVisionEngine, isVisionCapable, assertSafeBaseURL } from '../src/providers.js';
import { clearVisionCapabilitiesCache } from '../src/vision-capabilities.js';
import { tempVisionCache } from './helpers.js';

/** Minimal config with the given provider map. */
function cfgWith(providers) {
  return { localKey: 'k', port: 1, providers, visionBridge: { enabled: true, engine: 'auto', local: null } };
}

/**
 * Stub for https://models.dev/api.json — fresh fetchImpl per test defeats the
 * module-level single-flight cache, temp cachePath keeps disk hermetic.
 */
function stubSources(t, modelsDev) {
  clearVisionCapabilitiesCache();
  return async (url) => {
    if (String(url).includes('models.dev')) {
      return new Response(JSON.stringify(modelsDev), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
}

test('registry providers resolve with stored key and overrides', () => {
  const cfg = cfgWith({
    deepseek: { enabled: true, key: 'sk-test', overrides: { 'deepseek-v4-flash': { vision: true } } },
  });
  const route = resolveModel(cfg, 'deepseek/deepseek-v4-flash');
  assert.equal(route.key, 'sk-test');
  assert.equal(route.baseURL, 'https://api.deepseek.com/v1');
  assert.equal(route.meta.visionPin, true, 'user override wins');
  assert.equal(resolveModel(cfg, 'deepseek/deepseek-v4-pro').meta.visionPin, undefined, 'no pin: resolves dynamically');
});

test('disabled or keyless providers are invisible to the catalog', () => {
  const cfg = cfgWith({
    deepseek: { enabled: true },
    clinepass: { enabled: false, key: 'x' },
  });
  assert.deepEqual(catalog(cfg), []);
  assert.equal(resolveModel(cfg, 'deepseek/deepseek-v4-flash'), null);
});

test('env var beats stored key', () => {
  process.env.DEEPSEEK_API_KEY = 'sk-env';
  try {
    const entry = providerEntry(cfgWith({ deepseek: { enabled: true, key: 'sk-stored' } }), 'deepseek');
    assert.deepEqual(resolveKey(entry), { key: 'sk-env', source: 'env:DEEPSEEK_API_KEY' });
  } finally {
    delete process.env.DEEPSEEK_API_KEY;
  }
});

test('custom providers resolve and list', () => {
  const cfg = cfgWith({
    lmstudio: {
      enabled: true,
      baseURL: 'http://127.0.0.1:1234/v1',
      models: [{ id: 'qwen2.5-vl-3b', vision: true }],
    },
  });
  const route = resolveModel(cfg, 'lmstudio/qwen2.5-vl-3b');
  assert.equal(route.baseURL, 'http://127.0.0.1:1234/v1');
  assert.equal(route.key, null, 'loopback needs no key');
  assert.deepEqual(catalog(cfg).map((m) => m.id), ['lmstudio/qwen2.5-vl-3b']);
});

test('provider-level protocol repairs stale openai extras (opencode-go 500 regression)', () => {
  const cfg = cfgWith({
    'opencode-go': { enabled: true, key: 'sk', extra: [{ id: 'qwen3.8-max', protocol: 'openai' }] },
  });
  const route = resolveModel(cfg, 'opencode-go/qwen3.8-max');
  assert.equal(route.meta.protocol, 'messages', 'provider protocol beats the stale stamped default');
  assert.equal(route.upstreamModel, 'qwen3.8-max');
});

test('responses registry row beats stale openai extra (muse-spark)', () => {
  const cfg = cfgWith({
    'opencode-go': { enabled: true, key: 'sk', extra: [{ id: 'muse-spark-1.3-contributor', protocol: 'openai' }] },
  });
  const route = resolveModel(cfg, 'opencode-go/muse-spark-1.3-contributor');
  assert.equal(route.meta.protocol, 'responses', 'registry responses wins over stale openai stamp');
});

test('manually pinned responses extra survives the provider default', () => {
  const cfg = cfgWith({
    'opencode-go': { enabled: true, key: 'sk', extra: [{ id: 'future-spark', protocol: 'responses' }] },
  });
  assert.equal(resolveModel(cfg, 'opencode-go/future-spark').meta.protocol, 'responses');
});

test('custom provider models keep their explicit protocol', () => {
  const cfg = cfgWith({
    'my-relay': {
      enabled: true,
      label: 'relay',
      baseURL: 'http://127.0.0.1:9/v1',
      models: [{ id: 'a', protocol: 'messages' }, { id: 'b', protocol: 'openai' }],
    },
  });
  assert.equal(resolveModel(cfg, 'my-relay/a').meta.protocol, 'messages');
  assert.equal(resolveModel(cfg, 'my-relay/b').meta.protocol, 'openai');
});

test('auto vision engine prefers cheap tiers and needs vision+key', async () => {
  const cfg = cfgWith({
    'opencode-go': { enabled: true, key: 'sk-oc' },
  });
  const fetchImpl = stubSources(null, {
    'opencode-go': { models: { 'minimax-m3': { modalities: { input: ['text', 'image'] } } } },
  });
  const engine = await autoVisionEngine(cfg, { fetchImpl, cachePath: tempVisionCache() });
  assert.equal(engine.label, 'opencode-go/minimax-m3', 'cheapest vision-flagged opencode-go model');
});

test('auto vision engine returns null with no vision models', async () => {
  const cfg = cfgWith({ deepseek: { enabled: true, key: 'sk' } });
  const fetchImpl = stubSources(null, { deepseek: { models: { 'deepseek-v4-flash': { modalities: { input: ['text'] } } } } });
  assert.equal(await autoVisionEngine(cfg, { fetchImpl, cachePath: tempVisionCache() }), null);
});

test('unknown model ids passthrough an enabled provider', () => {
  const cfg = cfgWith({ 'opencode-go': { enabled: true, key: 'sk-oc' } });
  const route = resolveModel(cfg, 'opencode-go/brand-new-model');
  assert.equal(route.modelId, 'brand-new-model');
  assert.equal(route.meta.visionPin, undefined, 'unknown models stay dynamic, never pinned');
  assert.equal(route.meta.protocol, 'messages', 'opencode-go speaks Messages only — provider-level protocol');
  assert.equal(route.baseURL, 'https://opencode.ai/zen/go/v1');
  assert.equal(resolveModel(cfg, 'nobody/brand-new-model'), null);
  assert.equal(resolveModel(cfg, 'clinepass/brand-new-model'), null, 'provider not enabled');
});

test('models added via config extra appear in the catalog with protocol', () => {
  const cfg = cfgWith({
    'opencode-go': { enabled: true, key: 'sk-oc', extra: [{ id: 'shiny-new', vision: true, protocol: 'messages' }] },
  });
  assert.ok(catalog(cfg).map((m) => m.id).includes('opencode-go/shiny-new'));
  const route = resolveModel(cfg, 'opencode-go/shiny-new');
  assert.equal(route.meta.visionPin, true, '--vision pins native');
  assert.equal(route.meta.protocol, 'messages');
});

test('base URL policy: https or loopback only', () => {
  assert.doesNotThrow(() => assertSafeBaseURL('https://api.deepseek.com/v1'));
  assert.doesNotThrow(() => assertSafeBaseURL('http://127.0.0.1:1234/v1'));
  assert.throws(() => assertSafeBaseURL('http://evil.example.com/v1'), /https required/);
  assert.throws(() => assertSafeBaseURL('not a url'), /Invalid base URL/);
});

test('every registry base URL is https', () => {
  for (const p of Object.values(REGISTRY)) {
    assert.ok(p.baseURL.startsWith('https://'), p.baseURL);
  }
});

test('subscription providers from the codex-router catalog are registered', () => {
  const ids = Object.keys(REGISTRY);
  for (const id of [
    'opencode-go', 'opencode-zen', 'clinepass', 'qwen-plan',
    'commandcode', 'minimax-token-plan', 'ollama-cloud',
    'deepseek', 'kimi-api', 'kimi-api-cn', 'grok-api', 'anthropic-api',
    'gemini-api', 'groq', 'openrouter', 'together', 'fireworks', 'cerebras',
    'mistral', 'nvidia-nim', 'siliconflow', 'huggingface', 'chutes',
  ]) {
    assert.ok(ids.includes(id), `missing provider ${id}`);
  }
  assert.ok(!ids.includes('zai-coding'), 'ZCode already ships GLM Coding Plan — do not duplicate it');
  assert.deepEqual(REGISTRY['qwen-plan'].models, [], 'plain ids arrive via live refresh, not the registry');
  assert.deepEqual(REGISTRY.clinepass.models, [], 'upstreamPrefix covers clinepass renames — nothing to pin');
  assert.ok(REGISTRY['opencode-go'].models.every((m) => ['messages', 'responses'].includes(m.protocol) || m.upstream), 'registry keeps wire exceptions only');
  assert.ok(REGISTRY['opencode-go'].models.some((m) => m.id === 'minimax-m3' && m.protocol === 'messages'));
  assert.ok(REGISTRY['opencode-go'].models.some((m) => m.id === 'muse-spark-1.3-contributor' && m.protocol === 'responses'));
  assert.ok(REGISTRY['opencode-go'].models.some((m) => m.id === 'gpt-5.6-luna' && m.protocol === 'responses'));
  assert.ok(REGISTRY.commandcode.models.some((m) => m.id === 'claude-opus-4.8' && m.protocol === 'messages'));
  assert.equal(REGISTRY['anthropic-api'].protocol, 'messages');
  assert.equal(REGISTRY.groq.models.length, 0, 'catalog-only providers ship no pinned models');
});

test('clinepass and commandcode rewrite the upstream model id', () => {
  const cfg = cfgWith({
    clinepass: { enabled: true, key: 'sk-cp' },
    commandcode: { enabled: true, key: 'sk-cc' },
    'minimax-token-plan': { enabled: true, key: 'sk-mm' },
    'anthropic-api': { enabled: true, key: 'sk-an' },
  });
  const cline = resolveModel(cfg, 'clinepass/deepseek-v4-flash');
  assert.equal(cline.modelId, 'deepseek-v4-flash');
  assert.equal(cline.upstreamModel, 'cline-pass/deepseek-v4-flash');
  const gemini = resolveModel(cfg, 'commandcode/gemini-3.5-flash');
  assert.equal(gemini.upstreamModel, 'google/gemini-3.5-flash');
  const claude = resolveModel(cfg, 'commandcode/claude-opus-4.8');
  assert.equal(claude.meta.protocol, 'messages');
  assert.equal(claude.upstreamModel, 'claude-opus-4-8');
  assert.equal(resolveModel(cfg, 'minimax-token-plan/minimax-m3').upstreamModel, 'MiniMax-M3');
  assert.equal(resolveModel(cfg, 'anthropic-api/claude-opus-4.8').meta.protocol, 'messages');
  assert.equal(resolveModel(cfg, 'anthropic-api/claude-opus-4.8').upstreamModel, 'claude-opus-4-8');
});

test('kimi-k3 and qwen max on opencode-go are vision-capable', async () => {
  const cfg = cfgWith({ 'opencode-go': { enabled: true, key: 'sk-oc' } });
  const fetchImpl = stubSources(null, {
    moonshotai: { models: { 'kimi-k3': { modalities: { input: ['text', 'image', 'video'] } } } },
    qwen: { models: { 'qwen3.8-max': { modalities: { input: ['text', 'image', 'video'] } } } },
  });
  const vo = { fetchImpl, cachePath: tempVisionCache() };
  assert.equal(await isVisionCapable(cfg, 'opencode-go/kimi-k3', vo), true);
  assert.equal(await isVisionCapable(cfg, 'opencode-go/qwen3.8-max', vo), true);
  assert.equal(await isVisionCapable(cfg, 'opencode-go/deepseek-v4-flash', vo), false, 'unknown to catalogs stays text-only');
});

test('vision pin beats the dynamic lookup both ways', async () => {
  const cfg = cfgWith({
    'opencode-go': {
      enabled: true,
      key: 'sk-oc',
      overrides: { 'kimi-k3': { vision: false }, 'deepseek-v4-flash': { vision: true } },
    },
  });
  const fetchImpl = stubSources(null, {
    moonshotai: { models: { 'kimi-k3': { modalities: { input: ['text', 'image'] } } } },
  });
  const vo = { fetchImpl, cachePath: tempVisionCache() };
  assert.equal(await isVisionCapable(cfg, 'opencode-go/kimi-k3', vo), false, 'off pin wins over catalog vision');
  assert.equal(await isVisionCapable(cfg, 'opencode-go/deepseek-v4-flash', vo), true, 'on pin wins over catalog miss');
});

test('passthrough models honor vision overrides without models add', () => {
  const cfg = cfgWith({
    groq: { enabled: true, key: 'sk-groq', overrides: { 'llama-3.3-70b': { vision: true } } },
  });
  assert.equal(resolveModel(cfg, 'groq/llama-3.3-70b').meta.visionPin, true);
});

test('qwen-plan base URL can be overridden by env', () => {
  process.env.QWEN_PLAN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  try {
    const entry = providerEntry(cfgWith({ 'qwen-plan': { enabled: true, key: 'sk-sp' } }), 'qwen-plan');
    assert.equal(entry.baseURL, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  } finally {
    delete process.env.QWEN_PLAN_BASE_URL;
  }
  const def = providerEntry(cfgWith({ 'qwen-plan': { enabled: true, key: 'sk-sp' } }), 'qwen-plan');
  assert.match(def.baseURL, /token-plan\.ap-southeast-1/);
});

test('opencode-zen reuses the stored opencode-go key', () => {
  const cfg = cfgWith({
    'opencode-go': { enabled: true, key: 'sk-shared' },
    'opencode-zen': { enabled: true },
  });
  const zen = resolveModel(cfg, 'opencode-zen/whatever');
  assert.equal(zen.key, 'sk-shared');
  assert.equal(zen.baseURL, 'https://opencode.ai/zen/v1');
});
