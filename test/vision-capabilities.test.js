import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  visionKey,
  indexModelsDev,
  indexOpenRouter,
  lookupVision,
  resolveVisionSupport,
  getVisionIndex,
  clearVisionCapabilitiesCache,
  visionSourcesStatus,
  MODELS_DEV_URL,
  OPENROUTER_URL,
} from '../src/vision-capabilities.js';

function tempCache() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-router-vcap-')), 'vision.json');
}

function stubFetch({ modelsDev, openRouter, calls = {} } = {}) {
  clearVisionCapabilitiesCache();
  return async (url) => {
    const u = String(url);
    calls[u] = (calls[u] || 0) + 1;
    if (u === MODELS_DEV_URL) {
      if (modelsDev instanceof Error) throw modelsDev;
      if (modelsDev === null) return new Response('nope', { status: 500 });
      return new Response(JSON.stringify(modelsDev), { status: 200 });
    }
    if (u === OPENROUTER_URL) {
      if (openRouter instanceof Error) throw openRouter;
      if (openRouter === null || openRouter === undefined) return new Response('nope', { status: 500 });
      return new Response(JSON.stringify(openRouter), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  };
}

const MD = {
  'opencode-go': {
    models: {
      'omen-alpha': { modalities: { input: ['text', 'image'] } },
      'qwen3.7-max': { modalities: { input: ['text'] } },
      'kimi-k2.7-code': { modalities: { input: ['text', 'image', 'video'] } },
    },
  },
  moonshotai: {
    models: {
      'kimi-k3': { modalities: { input: ['text', 'image', 'video'] } },
      'kimi-k2.7-code': { modalities: { input: ['text', 'image', 'video'] } },
    },
  },
  greenpt: { models: { 'kimi-k2.7-code': { modalities: { input: ['text'] } } } },
  anthropic: { models: { 'claude-opus-4.8': { modalities: { input: ['text', 'image', 'pdf'] } } } },
};

test('visionKey ignores case, separators and :variants', () => {
  assert.equal(visionKey('opencode-go/Omen-Alpha'), 'opencodego/omenalpha');
  assert.equal(visionKey('xai/grok-4.5:batch'), 'xai/grok45');
  assert.equal(visionKey('claude-opus-4-8'), visionKey('claude-opus-4.8'));
});

test('indexModelsDev: exact opencode-go entry wins', () => {
  const index = indexModelsDev(MD);
  assert.equal(lookupVision(index, 'opencode-go/omen-alpha'), true);
  assert.equal(lookupVision(index, 'opencode-go/qwen3.7-max'), false);
});

test('indexModelsDev: suffix match across providers', () => {
  const index = indexModelsDev(MD);
  assert.equal(lookupVision(index, 'clinepass/kimi-k3'), true);
  assert.equal(lookupVision(index, 'cline-pass/deepseek-v4-flash'), null, 'absent model is unknown, not text-only');
});

test('indexModelsDev: majority beats a single stale flag', () => {
  const index = indexModelsDev(MD);
  assert.equal(lookupVision(index, 'kimi-k2.7-code'), true, '2 vision votes vs 1 text-only');
});

test('resolveVisionSupport reads models.dev, caches in memory', async () => {
  const calls = {};
  const opts = { fetchImpl: stubFetch({ modelsDev: MD, calls }), cachePath: tempCache() };
  assert.equal(await resolveVisionSupport('opencode-go/omen-alpha', opts), true);
  assert.equal(await resolveVisionSupport('opencode-go/omen-alpha', opts), true);
  assert.equal(calls[MODELS_DEV_URL], 1, 'single flight');
  assert.equal(calls[OPENROUTER_URL] || 0, 0, 'no fallback when models.dev answers');
});

test('resolveVisionSupport falls back to OpenRouter when models.dev fails', async () => {
  const opts = {
    fetchImpl: stubFetch({
      modelsDev: new Error('down'),
      openRouter: { data: [{ id: 'moonshotai/kimi-k3', architecture: { input_modalities: ['text', 'image'] } }] },
    }),
    cachePath: tempCache(),
  };
  assert.equal(await resolveVisionSupport('opencode-go/kimi-k3', opts), true);
});

test('resolveVisionSupport returns null when every source fails', async () => {
  const opts = { fetchImpl: stubFetch({ modelsDev: new Error('x'), openRouter: new Error('y') }), cachePath: tempCache() };
  assert.equal(await resolveVisionSupport('opencode-go/kimi-k3', opts), null);
});

test('getVisionIndex reuses the disk cache without fetching', async () => {
  const cachePath = tempCache();
  const calls = {};
  await getVisionIndex({ fetchImpl: stubFetch({ modelsDev: MD, calls }), cachePath });
  assert.equal(calls[MODELS_DEV_URL], 1);
  clearVisionCapabilitiesCache();
  const silent = async () => {
    throw new Error('must not fetch');
  };
  const index = await getVisionIndex({ fetchImpl: silent, cachePath });
  assert.equal(lookupVision(index, 'opencode-go/omen-alpha'), true);
});

test('upstream id quirks still match (claude-opus-4-8)', async () => {
  const opts = { fetchImpl: stubFetch({ modelsDev: MD }), cachePath: tempCache() };
  assert.equal(await resolveVisionSupport('claude-opus-4-8', opts), true);
});

test('indexOpenRouter reads input_modalities', () => {
  const index = indexOpenRouter({
    data: [
      { id: 'xiaomi/mimo-v2.5', architecture: { input_modalities: ['text', 'image', 'audio', 'video'] } },
      { id: 'xiaomi/mimo-v2.5-pro', architecture: { input_modalities: ['text'] } },
    ],
  });
  assert.equal(lookupVision(index, 'mimo-v2.5'), true);
  assert.equal(lookupVision(index, 'mimo-v2.5-pro'), false);
});

test('visionSourcesStatus reports missing cache', () => {
  const st = visionSourcesStatus(tempCache());
  assert.equal(st.ageMs, null);
});
