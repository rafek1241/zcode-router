import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { refreshCatalog } from '../src/catalog-refresh.js';

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
    assert.equal(cfg.providers.groq.extra.every((m) => m.vision === false), true);
  });
});

test('refresh skips ids already in the registry and extras already stored', async () => {
  await withModelsServer({ data: [{ id: 'deepseek-v4-flash' }, { id: 'shiny-new' }, { id: 'already' }] }, async (port) => {
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
    assert.ok(result.skipped.includes('deepseek-v4-flash'));
    assert.ok(result.kept.includes('already'));
    assert.equal(cfg.providers['opencode-go'].extra.filter((m) => m.id === 'shiny-new').length, 1);
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
