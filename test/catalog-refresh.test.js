import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { refreshCatalog, refreshEmptyProviders } from '../src/catalog-refresh.js';

async function withModelsServer(payload, fn) {
  const server = http.createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(server.address().port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('refresh merges live ids into extra without duplicating the registry', async () => {
  await withModelsServer({ data: [{ id: 'llama-3.3-70b' }, { id: 'deepseek-v4-flash' }] }, async (port) => {
    const cfg = {
      providers: {
        groq: { enabled: true, key: 'sk', baseURL: `http://127.0.0.1:${port}/v1` },
      },
    };
    const result = await refreshCatalog(cfg, 'groq', { fetchImpl: fetch });
    assert.deepEqual(result.added.sort(), ['deepseek-v4-flash', 'llama-3.3-70b']);
    assert.equal(cfg.providers.groq.extra.length, 2);
    assert.equal(cfg.providers.groq.extra.every((m) => m.vision === undefined), true, 'no vision flag: support resolves dynamically');
  });
});

test('refresh skips ids already in the registry and extras already stored', async () => {
  await withModelsServer({ data: [{ id: 'minimax-m3' }, { id: 'shiny-new' }, { id: 'already' }] }, async (port) => {
    const cfg = {
      providers: {
        'opencode-go': {
          enabled: true,
          key: 'sk',
          baseURL: `http://127.0.0.1:${port}/v1`,
          extra: [{ id: 'already', vision: false, protocol: 'openai' }],
        },
      },
    };
    const result = await refreshCatalog(cfg, 'opencode-go', { fetchImpl: fetch });
    assert.deepEqual(result.added, ['shiny-new']);
    assert.ok(result.skipped.includes('minimax-m3'));
    assert.ok(result.kept.includes('already'));
    assert.equal(cfg.providers['opencode-go'].extra.filter((m) => m.id === 'shiny-new').length, 1);
  });
});

test('plain ids are not registry-pinned: live refresh picks them up', async () => {
  await withModelsServer({ data: [{ id: 'kimi-k3' }] }, async (port) => {
    const cfg = {
      providers: {
        'opencode-go': { enabled: true, key: 'sk', baseURL: `http://127.0.0.1:${port}/v1` },
      },
    };
    const result = await refreshCatalog(cfg, 'opencode-go', { fetchImpl: fetch });
    assert.deepEqual(result.added, ['kimi-k3']);
    assert.deepEqual(cfg.providers['opencode-go'].extra, [{ id: 'kimi-k3', protocol: 'messages' }]);
  });
});

test('refresh --prune drops extras missing from the live list, never registry models', async () => {
  await withModelsServer({ data: [{ id: 'keep-me' }] }, async (port) => {
    const cfg = {
      providers: {
        groq: {
          enabled: true,
          key: 'sk',
          baseURL: `http://127.0.0.1:${port}/v1`,
          extra: [
            { id: 'keep-me', vision: false, protocol: 'openai' },
            { id: 'stale', vision: false, protocol: 'openai' },
          ],
        },
      },
    };
    const result = await refreshCatalog(cfg, 'groq', { fetchImpl: fetch, prune: true });
    assert.deepEqual(cfg.providers.groq.extra.map((m) => m.id), ['keep-me']);
    assert.ok(result.pruned.includes('stale'));
  });
});

test('refresh select callback keeps only picked new ids', async () => {
  await withModelsServer({ data: [{ id: 'a' }, { id: 'b' }] }, async (port) => {
    const cfg = {
      providers: {
        groq: { enabled: true, key: 'sk', baseURL: `http://127.0.0.1:${port}/v1` },
      },
    };
    const result = await refreshCatalog(cfg, 'groq', { fetchImpl: fetch, select: async (ids) => ids.filter((id) => id === 'b') });
    assert.deepEqual(result.added, ['b']);
    assert.deepEqual(cfg.providers.groq.extra.map((m) => m.id), ['b']);
  });
});

test('refreshed opencode-go extras inherit the messages protocol', async () => {
  await withModelsServer({ data: [{ id: 'shiny-new-model' }] }, async (port) => {
    const cfg = { providers: { 'opencode-go': { enabled: true, key: 'sk', baseURL: `http://127.0.0.1:${port}/v1` } } };
    await refreshCatalog(cfg, 'opencode-go', { fetchImpl: fetch });
    assert.equal(cfg.providers['opencode-go'].extra[0].protocol, 'messages', 'provider-level protocol, not the openai default');
  });
});

test('refreshed registry ids are skipped, never duplicated as extras', async () => {
  await withModelsServer({ data: [{ id: 'muse-spark-1.3-contributor' }] }, async (port) => {
    const cfg = { providers: { 'opencode-go': { enabled: true, key: 'sk', baseURL: `http://127.0.0.1:${port}/v1` } } };
    const result = await refreshCatalog(cfg, 'opencode-go', { fetchImpl: fetch });
    assert.ok(result.skipped.includes('muse-spark-1.3-contributor'));
    assert.equal(cfg.providers['opencode-go'].extra?.length || 0, 0);
  });
});

test('refreshEmptyProviders fills empty registry providers, skips the rest', async () => {
  await withModelsServer({ data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }] }, async (port) => {
    const cfg = {
      providers: {
        // enabled + key + no models (the upgrade case): refreshed
        deepseek: { enabled: true, key: 'sk', baseURL: `http://127.0.0.1:${port}/v1` },
        // already has models: untouched
        groq: { enabled: true, key: 'sk', baseURL: `http://127.0.0.1:${port}/v1`, extra: [{ id: 'kept', protocol: 'openai' }] },
        // custom provider: user-managed, untouched
        'my-relay': { enabled: true, label: 'mine', baseURL: `http://127.0.0.1:${port}/v1` },
        // enabled but keyless and not loopback: skipped without fetching
        'kimi-api': { enabled: true, baseURL: 'https://api.moonshot.ai/v1' },
        // disabled: skipped
        'grok-api': { enabled: false, key: 'sk', baseURL: `http://127.0.0.1:${port}/v1` },
      },
    };
    const refreshed = await refreshEmptyProviders(cfg, { fetchImpl: fetch });
    assert.deepEqual(refreshed, ['deepseek']);
    assert.deepEqual(cfg.providers.deepseek.extra.map((m) => m.id), ['deepseek-v4-flash', 'deepseek-v4-pro']);
    assert.deepEqual(cfg.providers.groq.extra.map((m) => m.id), ['kept']);
    assert.equal(cfg.providers['my-relay'].extra, undefined);
    assert.equal(cfg.providers['kimi-api'].extra, undefined);
    assert.equal(cfg.providers['grok-api'].extra, undefined);
  });
});

test('refreshEmptyProviders stays quiet when every source is empty', async () => {
  const cfg = { providers: { deepseek: { enabled: true, key: 'sk', baseURL: 'https://api.deepseek.invalid/v1' } } };
  const refreshed = await refreshEmptyProviders(cfg, { fetchImpl: async () => { throw new Error('boom'); } });
  assert.deepEqual(refreshed, []);
});
