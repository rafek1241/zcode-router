import test from 'node:test';
import assert from 'node:assert/strict';
import { REGISTRY, providerEntry, resolveModel, resolveKey, catalog, autoVisionEngine, assertSafeBaseURL } from '../src/providers.js';

function cfgWith(providers) {
  return { localKey: 'k', port: 1, providers, visionBridge: { enabled: true, engine: 'auto', local: null } };
}

test('registry providers resolve with stored key and overrides', () => {
  const cfg = cfgWith({
    deepseek: { enabled: true, key: 'sk-test', overrides: { 'deepseek-v4-flash': { vision: true } } },
  });
  const route = resolveModel(cfg, 'deepseek/deepseek-v4-flash');
  assert.equal(route.key, 'sk-test');
  assert.equal(route.baseURL, 'https://api.deepseek.com/v1');
  assert.equal(route.meta.vision, true, 'user override wins');
  assert.equal(resolveModel(cfg, 'deepseek/deepseek-v4-pro').meta.vision, false);
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

test('auto vision engine prefers cheap tiers and needs vision+key', () => {
  const cfg = cfgWith({
    'opencode-go': { enabled: true, key: 'sk-oc' },
  });
  const engine = autoVisionEngine(cfg);
  assert.equal(engine.label, 'opencode-go/minimax-m3', 'cheapest vision-flagged opencode-go model');
});

test('auto vision engine returns null with no vision models', () => {
  const cfg = cfgWith({ deepseek: { enabled: true, key: 'sk' } });
  assert.equal(autoVisionEngine(cfg), null);
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
